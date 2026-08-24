-- ===========================================================================
-- Unbill passcode — the unbill happens INSIDE the function
-- ===========================================================================
-- rsr-billing is a static page on a public URL, so anything checked in
-- browser JS is in view-source. But moving the check server-side is not
-- enough on its own: RLS on drawing_billing is `to authenticated using
-- (true)`, so any signed-in user could PATCH status back to DRAFT directly
-- and never touch the passcode at all.
--
-- So the function does the unbill itself, and a trigger refuses BILLED to
-- DRAFT from any other path. Together those make the passcode the only way
-- back to draft, rather than the polite way.
--
-- Safe to re-run: every statement is guarded, and the passcode insert will
-- not overwrite one already set.

-- ---------------------------------------------------------------------------
-- 1. the secret and the throttle
-- ---------------------------------------------------------------------------
create table if not exists public.billing_unbill_credential (
  id            boolean primary key default true check (id),
  passcode_hash text not null,
  updated_at    timestamptz not null default now()
);

create table if not exists public.billing_unbill_throttle (
  id           boolean primary key default true check (id),
  fails        integer     not null default 0,
  window_start timestamptz not null default now(),
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);

-- RLS on with NO policy denies every role outright. The functions below run
-- as postgres, which bypasses RLS, so they still read it -- and nothing else
-- can, including a signed-in user holding the anon key and a session.
alter table public.billing_unbill_credential enable row level security;
alter table public.billing_unbill_throttle   enable row level security;

-- ---------------------------------------------------------------------------
-- 2. SET THE PASSCODE — edit the six digits, then run. Only the hash is
--    stored; the digits exist only in your SQL editor session.
-- ---------------------------------------------------------------------------
insert into public.billing_unbill_credential (id, passcode_hash)
values (true, extensions.crypt('123456', extensions.gen_salt('bf', 10)))
on conflict (id) do nothing;          -- will NOT clobber an existing passcode

-- To CHANGE it later, run this on its own with the new digits:
--   update public.billing_unbill_credential
--      set passcode_hash = extensions.crypt('654321', extensions.gen_salt('bf', 10)),
--          updated_at = now()
--    where id;

-- ---------------------------------------------------------------------------
-- 3. the gate
-- ---------------------------------------------------------------------------
create or replace function public.verify_unbill_passcode(p_input text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  v_now timestamptz := now();
  v_row public.billing_unbill_throttle%rowtype;
  v_ok  boolean;
  MAX_FAILS constant int      := 10;
  COOLDOWN  constant interval := interval '15 minutes';
begin
  insert into public.billing_unbill_throttle (id) values (true)
    on conflict on constraint billing_unbill_throttle_pkey do nothing;
  select * into v_row from public.billing_unbill_throttle t where t.id for update;

  -- FAIL-CLOSED: while locked, deny WITHOUT checking the passcode, so a
  -- locked-out attacker cannot tell a correct guess from a wrong one.
  --
  -- DELIBERATE TRADE-OFF: this is ONE passcode shared by everyone, so the
  -- lock is global -- there is no user to key it to. The cost is a denial of
  -- service: anyone who can reach this can stop all unbilling for fifteen
  -- minutes by guessing wrong ten times. Accepted, because the alternative is
  -- unlimited guessing at a six-digit secret, and because unbilling is rare
  -- and delay is recoverable -- a quarter of an hour costs far less than a
  -- stranger walking an issued billing back to draft. Revisit if unbilling
  -- ever becomes routine.
  if v_row.locked_until is not null and v_row.locked_until > v_now then
    update public.billing_unbill_throttle t set updated_at = v_now where t.id;
    return false;
  end if;

  if v_now - v_row.window_start > COOLDOWN then
    v_row.fails := 0;
    v_row.window_start := v_now;
  end if;

  select exists (
    select 1 from public.billing_unbill_credential c
     where c.passcode_hash = extensions.crypt(p_input, c.passcode_hash)
  ) into v_ok;

  if not v_ok then
    update public.billing_unbill_throttle t
       set fails        = v_row.fails + 1,
           window_start = v_row.window_start,
           locked_until = case when v_row.fails + 1 >= MAX_FAILS
                               then v_now + COOLDOWN else null end,
           updated_at   = v_now
     where t.id;
    return false;
  end if;

  update public.billing_unbill_throttle t
     set fails = 0, window_start = v_now, locked_until = null, updated_at = v_now
   where t.id;
  return true;
end
$fn$;

-- ---------------------------------------------------------------------------
-- 4. the trigger — BILLED to DRAFT only through unbill_group
-- ---------------------------------------------------------------------------
-- unbill_group sets a transaction-local flag; the trigger refuses the
-- transition when that flag is absent. set_config(..., true) is scoped to the
-- transaction, so it cannot leak into a later statement on the same session.
--
-- READ THIS BEFORE YOU NEED IT: this means a stuck billing CANNOT be walked
-- back to draft by hand in the SQL editor. A plain
--     update drawing_billing set status='DRAFT' where ...
-- will be refused, by design and regardless of who runs it. To fix a row
-- outside the app you must either
--   (a) call the function:
--         select public.unbill_group('<group_id>', '<the passcode>');
--   or (b) drop the trigger, fix the row, and put it back:
--         drop trigger rsr_dwg_unbill_guard on public.drawing_billing;
--         update public.drawing_billing set status='DRAFT', billed_date=null,
--                paid_date=null where group_id = '<gid>';
--         create trigger rsr_dwg_unbill_guard
--           before update on public.drawing_billing
--           for each row execute function public.rsr_dwg_block_unbill();
-- Option (a) is preferred: it goes through the throttle and leaves the same
-- trail as the app. Option (b) is the break-glass, and it is deliberately
-- inconvenient.
create or replace function public.rsr_dwg_block_unbill()
returns trigger
language plpgsql
as $fn$
begin
  if old.status = 'BILLED' and new.status = 'DRAFT'
     and coalesce(current_setting('rsr.unbilling', true), '') <> '1' then
    raise exception
      'A billed billing can only be returned to draft through unbill_group, which requires the passcode'
      using errcode = 'check_violation';
  end if;
  return new;
end
$fn$;

drop trigger if exists rsr_dwg_unbill_guard on public.drawing_billing;
create trigger rsr_dwg_unbill_guard
  before update on public.drawing_billing
  for each row execute function public.rsr_dwg_block_unbill();

-- ---------------------------------------------------------------------------
-- 5. the only way back to draft
-- ---------------------------------------------------------------------------
-- Mirrors what the app used to do locally: every line of the group moves
-- together, and both dates are cleared. group_id is nullable on rows that
-- predate grouping, where the row's own id is its group -- same rule as
-- groupIdOf() in index.html.
create or replace function public.unbill_group(p_gid text, p_passcode text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  v_n int;
begin
  if public.verify_unbill_passcode(p_passcode) is not true then
    return jsonb_build_object('ok', false, 'reason', 'Wrong passcode');
  end if;
  if p_gid is null or btrim(p_gid) = '' then
    return jsonb_build_object('ok', false, 'reason', 'No billing given');
  end if;

  -- tells the trigger this transition is the sanctioned one
  perform set_config('rsr.unbilling', '1', true);

  update public.drawing_billing b
     set status = 'DRAFT', billed_date = null, paid_date = null
   where coalesce(b.group_id::text, b.id::text) = btrim(p_gid)
     and b.status = 'BILLED';
  get diagnostics v_n = row_count;

  if v_n = 0 then
    return jsonb_build_object('ok', false, 'reason', 'Nothing billed to undo on that billing');
  end if;
  return jsonb_build_object('ok', true, 'lines', v_n);
end
$fn$;

revoke all on function public.verify_unbill_passcode(text) from public;
revoke all on function public.unbill_group(text, text)     from public;
-- the billing app always has a session, so anon never needs either
grant execute on function public.verify_unbill_passcode(text) to authenticated;
grant execute on function public.unbill_group(text, text)     to authenticated;
