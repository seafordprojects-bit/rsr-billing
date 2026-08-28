# Send-History Snapshot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every emailed billing records an immutable snapshot of exactly what the client received — number, lines, total, recipients, sender, and how it differs from the previous send — so corrections can be explained, senders attributed, and a re-sent PDF marked "Revised".

**Architecture:** A new `drawing_billing_send_log` table, one row per billing per send. All of it is written by one `record_billing_send` RPC that takes a `gid` and builds the snapshot **itself, from `drawing_billing`** — the caller never supplies line data, so the record is server truth rather than a client claim. `send_no` is claimed by compare-and-swap against a `unique (gid, send_no)` constraint, the same idiom the billing-number counter uses. `send-statement` calls the RPC after Resend accepts, and a failure there is logged but never fails the send: the mail has already gone.

**Tech Stack:** Plain ES5-flavoured JS inside one IIFE in `index.html`; Postgres 17 / PostgREST on Supabase; Deno Edge Function; Node-only test harness, no dependencies.

## Global Constraints

- **Everything is one file.** All app code goes in `index.html` inside the existing IIFE. No build step, no bundler, no package manager, no framework.
- **Anchored edits, never line-range replacement.** A range edit here once deleted 190 lines silently and `node --check` passed, because missing functions are not a syntax error. After any bulk edit, grep for the symbols you expect.
- **After every edit to `index.html`, syntax-check the extracted script:**
  `sed -n '/^<script>$/,/^<\/script>$/p' index.html | sed '1d;$d' > /tmp/app.js && node --check /tmp/app.js`
- **LF line endings.** Never let a tool rewrite the file as CRLF.
- **No backticks and no `${` inside `sqlText()`.** It returns a JS template literal; either one terminates it and takes the whole script with it. The one existing `${b}` is the bucket name and is deliberate.
- **Never a bare `alter` or `create` in `sqlText()`** — always `if not exists` / `if exists` / `create or replace`, because the whole script is re-run by hand.
- **Policies are `to authenticated` only, never the anon role.** `settings.test.mjs:82` asserts the literal string `to anon` appears nowhere in `index.html` — including in comments. Write "the anon role" in prose.
- **Function grants must be explicit.** Supabase grants EXECUTE on new `public` functions to the anon role by default. Every new function needs a matching revoke, added to the hardening block already in `sqlText()`.
- **`pdfPlan` must never touch the DOM.** No `$(...)`, no `document.`. `pdfplan.test.mjs` proves it by mutating `facts` and asserting the output follows.
- **Every string entering a PDF op goes through `pdfText`.** jsPDF's standard fonts are cp1252; one character above U+00FF re-encodes the whole string as UTF-16 and turns the line to rubbish.
- **`send_no`, never `revision`.** `drawing_billing` already has `rev_of`/`rev_no` for *drawing* revisions (Rev 1 of a Shafting Arrangement). A column called `revision` would collide with that concept in every later conversation.
- **Sends are attributed to the Supabase Auth identity**, never to a `billing_unbill_operator`. There is no passcode prompt on email.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `index.html` → `sqlText()` | table, index, RLS policy, `billing_line_diff`, `record_billing_send`, revoke | modify |
| `index.html` → app JS | `sendLogFor()`, `lSend` passing `gids`, `stmtFacts` fields, `pdfPlan` Revised line, letter placeholders, Monitoring attribution | modify |
| `supabase/functions/send-statement/index.ts` | accept `gids`, call the RPC after Resend accepts | modify |
| `test/sendlog.test.mjs` | new suite: SQL contract, `sendLogFor`, `stmtFacts`, `pdfPlan`, letter keys | create |
| `test/fn.test.mjs` | the function's RPC call, and that a logging failure does not fail the send | modify |
| `MANUAL-TEST.md` | section 10: re-send, Revised line, correction letter | modify |
| `CLAUDE.md` | the send-log model, and why the snapshot is server-side | modify |

**Task order rationale:** Task 1 is the foundation everything else calls, and it is the only task requiring a manual SQL run. Task 2 makes the write real end to end. Task 3 gets the data back into the app. Tasks 4–6 are the three features, each independently shippable once 1–3 land.

---

### Task 1: Schema and the `record_billing_send` RPC

**Files:**
- Modify: `index.html` — inside `sqlText()`, immediately after `alter table billing_senders enable row level security;`
- Modify: `index.html` — the existing unbill hardening `do $BODY$` block, to add the new function to the revoke list
- Test: `test/sendlog.test.mjs` (create)

**Interfaces:**
- Produces: table `drawing_billing_send_log`; `billing_line_diff(p_prev jsonb, p_cur jsonb) returns jsonb`; `record_billing_send(p_gid text, p_bill_no text, p_to text, p_cc text[], p_sent_by_uid uuid, p_sent_by_email text, p_provider_id text, p_letter_text text) returns jsonb` returning `{ok:true, send_no:int, change_kind:text, total_delta:numeric, total:numeric}` or `{ok:false, reason:text}`.

- [ ] **Step 1: Write the failing test**

Create `test/sendlog.test.mjs`:

```js
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || path.join(ROOT, 'index.html');
import { net } from './harness.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra='') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const html = fs.readFileSync(SRC, 'utf8');

console.log('\n--- A. the send log is in the SQL ---');
ok('table created', /create table if not exists drawing_billing_send_log/.test(html));
ok('one send number per billing',
   /unique \(gid, send_no\)/.test(html));
ok('send_no, not revision',
   /send_no\s+int\s+not null/.test(html) && !/\brevision\s+int\b/.test(html));
ok('RLS enabled',
   /alter table drawing_billing_send_log enable row level security/.test(html));
ok('readable by authenticated',
   /create policy rsr_dwg_sendlog_read on drawing_billing_send_log\s*\n\s*for select to authenticated/.test(html));
ok('no insert policy — only the service key writes',
   !/on drawing_billing_send_log\s*\n\s*for (all|insert)/.test(html));
ok('the RPC exists', /create or replace function public\.record_billing_send/.test(html));
ok('the diff helper exists', /create or replace function public\.billing_line_diff/.test(html));
ok('the RPC snapshots from the table, not from the caller',
   /from public\.drawing_billing b/.test(html) && !/p_lines/.test(html));
ok('no-charge lines contribute zero, matching amountOf',
   /case when b\.billable is false then 0/.test(html));
ok('the RPC is revoked from the anon role',
   /'public\.record_billing_send\(text,text,text,text\[\],uuid,text,text,text\)'/.test(html));

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test/sendlog.test.mjs`
Expected: FAIL on every assertion in section A — nothing exists yet.

- [ ] **Step 3: Add the DDL to `sqlText()`**

Anchor on the existing line `alter table billing_senders enable row level security;` and insert **after** it, **before** the `-- Unbilling: authenticated callers only` comment:

```sql
-- ---------------------------------------------------------------
-- What was sent, and when. One row per billing per send: a
-- correction keeps its billing number, so send_no is what tells
-- send #1 from send #2, not a suffix on bill_no.
--
-- The snapshot is built in record_billing_send from drawing_billing
-- itself. The caller never supplies line data -- a stale device would
-- otherwise record a billing the database never held, and this table
-- is the record of what the client actually received.
--
-- Readable by any signed-in user, writable by nobody: RLS with a
-- select policy and no other, so only send-statement's service key
-- can insert. The rows are a record, not working state.
-- ---------------------------------------------------------------
create table if not exists drawing_billing_send_log (
  id            bigserial primary key,
  gid           text        not null,
  bill_no       text        not null,
  send_no       int         not null,
  sent_at       timestamptz not null default now(),
  sent_by_uid   uuid,
  sent_by_email text        not null,
  to_email      text        not null,
  cc_emails     text[]      not null default '{}',
  provider_id   text,
  total         numeric(14,2) not null,
  line_count    int         not null,
  lines         jsonb       not null,
  prev_send_no  int,
  change_kind   text        not null,
  total_delta   numeric(14,2),
  changed_lines jsonb       not null default '[]',
  letter_text   text,
  constraint drawing_billing_send_log_gid_no unique (gid, send_no)
);

create index if not exists drawing_billing_send_log_gid_idx
  on drawing_billing_send_log (gid, send_no desc);

alter table drawing_billing_send_log enable row level security;

drop policy if exists rsr_dwg_sendlog_read on drawing_billing_send_log;
create policy rsr_dwg_sendlog_read on drawing_billing_send_log
  for select to authenticated using (true);

-- What changed between two snapshots. Line identity is drawing_billing.id,
-- which is stable, so an edited line reads as amended. The known limit: a
-- line deleted and re-entered gets a new id and shows as removed + added.
-- Accepted -- the alternative is inventing a business key the lines do not
-- have.
create or replace function public.billing_line_diff(p_prev jsonb, p_cur jsonb)
returns jsonb
language sql
immutable
set search_path to 'public'
as $BODY$
  with prev as (
    select (e->>'id') as id,
           coalesce(e->>'drawing_title','') as title,
           coalesce((e->>'qty')::numeric, 0)  as qty,
           coalesce((e->>'rate')::numeric, 0) as rate
      from jsonb_array_elements(coalesce(p_prev, '[]'::jsonb)) e
  ), cur as (
    select (e->>'id') as id,
           coalesce(e->>'drawing_title','') as title,
           coalesce((e->>'qty')::numeric, 0)  as qty,
           coalesce((e->>'rate')::numeric, 0) as rate
      from jsonb_array_elements(coalesce(p_cur, '[]'::jsonb)) e
  )
  select coalesce(jsonb_agg(d order by d->>'title'), '[]'::jsonb) from (
    select jsonb_build_object('op','removed','id',p.id,'title',p.title,
             'was', jsonb_build_object('qty',p.qty,'rate',p.rate)) as d
      from prev p left join cur c on c.id = p.id where c.id is null
    union all
    select jsonb_build_object('op','added','id',c.id,'title',c.title,
             'now', jsonb_build_object('qty',c.qty,'rate',c.rate))
      from cur c left join prev p on p.id = c.id where p.id is null
    union all
    select jsonb_build_object('op','amended','id',c.id,'title',c.title,
             'was', jsonb_build_object('qty',p.qty,'rate',p.rate,'title',p.title),
             'now', jsonb_build_object('qty',c.qty,'rate',c.rate,'title',c.title))
      from cur c join prev p on p.id = c.id
     where p.qty <> c.qty or p.rate <> c.rate or p.title <> c.title
  ) x;
$BODY$;

-- Records one send. Claims send_no by compare-and-swap against the unique
-- constraint: a second device racing this insert loses and retries against
-- the fresh maximum, exactly as the billing-number claim does.
create or replace function public.record_billing_send(
  p_gid           text,
  p_bill_no       text,
  p_to            text,
  p_cc            text[] default '{}',
  p_sent_by_uid   uuid   default null,
  p_sent_by_email text   default null,
  p_provider_id   text   default null,
  p_letter_text   text   default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $BODY$
declare
  v_lines   jsonb;
  v_total   numeric(14,2);
  v_count   int;
  v_prev    public.drawing_billing_send_log%rowtype;
  v_no      int;
  v_kind    text;
  v_delta   numeric(14,2);
  v_changed jsonb;
  v_try     int := 0;
begin
  if p_gid is null or btrim(p_gid) = '' then
    return jsonb_build_object('ok', false, 'reason', 'No billing given');
  end if;
  if p_sent_by_email is null or btrim(p_sent_by_email) = '' then
    return jsonb_build_object('ok', false, 'reason', 'No sender given');
  end if;

  -- billable is false means no charge, matching amountOf in the app; null
  -- and true both charge, so "is false" is the right test, not "= false"
  select jsonb_agg(to_jsonb(b) order by b.line_no nulls last, b.created_at, b.id),
         coalesce(sum(case when b.billable is false then 0
                           else round(coalesce(b.qty,0) * coalesce(b.rate,0), 2) end), 0),
         count(*)
    into v_lines, v_total, v_count
    from public.drawing_billing b
   where coalesce(b.group_id::text, b.id::text) = btrim(p_gid);

  if v_count = 0 then
    return jsonb_build_object('ok', false, 'reason', 'That billing has no lines');
  end if;

  select * into v_prev
    from public.drawing_billing_send_log
   where gid = btrim(p_gid)
   order by send_no desc
   limit 1;

  if v_prev.id is null then
    v_kind := 'first'; v_delta := null; v_changed := '[]'::jsonb;
  else
    v_delta   := v_total - v_prev.total;
    v_changed := public.billing_line_diff(v_prev.lines, v_lines);
    v_kind    := case when v_delta > 0 then 'increased'
                      when v_delta < 0 then 'decreased'
                      when v_changed = '[]'::jsonb then 'unchanged'
                      else 'restructured' end;
  end if;

  loop
    v_try := v_try + 1;
    select coalesce(max(send_no), 0) + 1 into v_no
      from public.drawing_billing_send_log where gid = btrim(p_gid);
    begin
      insert into public.drawing_billing_send_log
        (gid, bill_no, send_no, sent_by_uid, sent_by_email, to_email, cc_emails,
         provider_id, total, line_count, lines, prev_send_no, change_kind,
         total_delta, changed_lines, letter_text)
      values
        (btrim(p_gid), p_bill_no, v_no, p_sent_by_uid, btrim(p_sent_by_email),
         p_to, coalesce(p_cc, '{}'), p_provider_id, v_total, v_count, v_lines,
         v_prev.send_no, v_kind, v_delta, v_changed, p_letter_text);
      exit;
    exception when unique_violation then
      if v_try >= 5 then
        return jsonb_build_object('ok', false, 'reason', 'Could not claim a send number');
      end if;
    end;
  end loop;

  return jsonb_build_object('ok', true, 'send_no', v_no, 'change_kind', v_kind,
                            'total_delta', v_delta, 'total', v_total);
end
$BODY$;
```

- [ ] **Step 4: Add the new function to the existing revoke list**

In the `do $BODY$` hardening block already in `sqlText()`, extend the array:

```sql
  foreach f in array array[
    'public.unbill_group(text,text,text)',
    'public.add_unbill_operator(text,text,text)',
    'public.resolve_unbill_operator(text)',
    'public.set_unbill_passcode(text,text)',
    'public.record_billing_send(text,text,text,text[],uuid,text,text,text)'
  ] loop
```

- [ ] **Step 5: Run the tests and the syntax check**

```bash
sed -n '/^<script>$/,/^<\/script>$/p' index.html | sed '1d;$d' > /tmp/app.js && node --check /tmp/app.js
node test/sendlog.test.mjs
node test/run.mjs
```
Expected: `node --check` silent; sendlog PASS on all of section A; `31 suites … 0 failed` plus the new suite (32 suites).

- [ ] **Step 6: Run the SQL against the live project, then verify it**

Copy Settings → Show SQL and run it in the Supabase SQL editor. Then confirm the grant did **not** default open:

```bash
supabase db query --linked "select has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec, has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='record_billing_send'"
```
Expected: `anon_exec false`, `auth_exec true`. If `anon_exec` is true the revoke did not run — re-run the SQL.

- [ ] **Step 7: Commit**

```bash
git add index.html test/sendlog.test.mjs
git commit -m "add the send-log table and record_billing_send"
```

---

### Task 2: `send-statement` records the send

**Files:**
- Modify: `supabase/functions/send-statement/index.ts:166-192` (accept `gids`), and `:288-289` (call the RPC before returning)
- Test: `test/fn.test.mjs`

**Interfaces:**
- Consumes: `record_billing_send(...)` from Task 1.
- Produces: the response gains `logged: boolean` and `send_no: number|null`. Request body gains `gids: string[]`.

**Why the write lives here:** only this function knows the send succeeded — it holds the Resend response. If the app wrote the row, a lost response means either a recorded send that never went or a real send with no record.

**Why a logging failure must not fail the send:** by the time the RPC is called the mail has left. Returning `ok:false` would tell the user their billing failed when the client already has it, and `lSend` would skip `markBilledNow`. So the RPC failure is logged loudly and reported as `logged:false`.

- [ ] **Step 1: Write the failing test**

Add to `test/fn.test.mjs`, after section I2, extending the `fetch` shim's dispatch first:

```js
// the send log RPC — record what the handler posts, and let a suite fail it
netState.rpcCalls = [];
netState.rpcOk = true;
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts={}) => {
  if (String(url).includes('/rest/v1/rpc/record_billing_send')) {
    netState.rpcCalls.push(JSON.parse(opts.body || '{}'));
    return { ok: netState.rpcOk, status: netState.rpcOk ? 200 : 500,
             text: async () => netState.rpcOk
               ? JSON.stringify({ ok:true, send_no:2, change_kind:'decreased', total_delta:-500 })
               : 'boom',
             json: async () => netState.rpcOk
               ? { ok:true, send_no:2, change_kind:'decreased', total_delta:-500 }
               : { message:'boom' } };
  }
  return origFetch(url, opts);
};

console.log('\n--- J. the send is recorded ---');
netState.rpcCalls = []; netState.rpcOk = true;
let res = await handler(new Request('https://x/', { method:'POST',
  headers:{ Authorization:'Bearer t' },
  body: JSON.stringify({ ...good, gids:['g-1'] }) }));
let out = await res.json();
ok('the send succeeded', out.ok === true, JSON.stringify(out));
ok('the RPC was called once', netState.rpcCalls.length === 1, String(netState.rpcCalls.length));
ok('it passed the gid', netState.rpcCalls[0].p_gid === 'g-1');
ok('it passed the sender, not an operator',
   netState.rpcCalls[0].p_sent_by_email === 'raffy@rsr.test');
ok('it passed the auth uid', netState.rpcCalls[0].p_sent_by_uid === 'u1');
ok('it never passes line data',
   !('p_lines' in netState.rpcCalls[0]) && !('p_total' in netState.rpcCalls[0]));
ok('the send number comes back', out.send_no === 2, String(out.send_no));
ok('and it reports being logged', out.logged === true);

console.log('\n--- J2. a logging failure does not fail the send ---');
netState.rpcCalls = []; netState.rpcOk = false;
res = await handler(new Request('https://x/', { method:'POST',
  headers:{ Authorization:'Bearer t' },
  body: JSON.stringify({ ...good, gids:['g-1'] }) }));
out = await res.json();
ok('the send still succeeded', out.ok === true, JSON.stringify(out));
ok('but it says it was not logged', out.logged === false);
netState.rpcOk = true;
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --experimental-strip-types test/fn.test.mjs`
Expected: FAIL on "the RPC was called once" — the handler makes no such call yet.

- [ ] **Step 3: Accept `gids` in the request**

After the `const html = ...` line at `:178`, add:

```ts
  // Which billings this email covers. One row is logged per billing, because
  // bill_no is per group and so is its send history. Absent means an older
  // app build: the mail still goes, it simply is not recorded.
  const gids = Array.isArray(body.gids)
    ? (body.gids as unknown[]).map(g => cleanHeader(g, 80)).filter(Boolean)
    : [];
```

- [ ] **Step 4: Call the RPC after Resend accepts**

Replace the final two lines of the handler (`:288-289`):

```ts
  // The mail has gone. Everything below is bookkeeping, and a failure here
  // must never be reported as a failed send -- the client already has it.
  let logged = gids.length > 0;
  let sendNo: number | null = null;
  for (const gid of gids) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/record_billing_send`, {
        method: "POST",
        headers: { ...svc, "Content-Type": "application/json" },
        body: JSON.stringify({
          p_gid: gid,
          p_bill_no: statementNo || null,
          p_to: to,
          p_cc: cc ? [cc] : [],
          p_sent_by_uid: user.id ?? null,
          p_sent_by_email: senderEmail,
          p_provider_id: (parsed?.id as string) ?? null,
          p_letter_text: html,
        }),
      });
      const txt = await r.text();
      const rec = txt ? JSON.parse(txt) : null;
      if (!r.ok || rec?.ok !== true) {
        logged = false;
        console.error("send log refused", gid, r.status, rec?.reason ?? txt);
      } else if (sendNo === null) {
        sendNo = rec.send_no as number;
      }
    } catch (e) {
      logged = false;
      console.error("send log threw", gid, e);
    }
  }

  console.log(`statement ${statementNo || "(no number)"} sent to ${to}${cc ? ` cc ${cc}` : ""} by ${senderEmail}${logged ? ` (send #${sendNo})` : " (not logged)"}`);
  return json({ ok: true, id: parsed?.id ?? null, to,
                statement_no: statementNo || null, logged, send_no: sendNo });
```

- [ ] **Step 5: Run the tests**

```bash
node --experimental-strip-types test/fn.test.mjs
node test/run.mjs
```
Expected: sections J and J2 PASS; whole suite 0 failed.

- [ ] **Step 6: Deploy and commit**

```bash
supabase functions deploy send-statement
git add supabase/functions/send-statement/index.ts test/fn.test.mjs
git commit -m "record every send from the function that knows it succeeded"
```

---

### Task 3: The app sends `gids` and can read its own history

**Files:**
- Modify: `index.html:4069-4078` (the `payload` object in `lSend`)
- Modify: `index.html` — add `sendLogFor` beside `groupById` (~`:1311`)
- Modify: `test/harness.mjs:40` — expose `sendLogFor`
- Test: `test/sendlog.test.mjs`

**Interfaces:**
- Consumes: `logged`/`send_no` from Task 2; the `drawing_billing_send_log` select policy from Task 1.
- Produces: `async sendLogFor(gid) -> {gid, bill_no, send_no, sent_at, sent_by_email, total, change_kind, total_delta, changed_lines}|null` — the newest row for that billing, or `null` when never sent or offline.

- [ ] **Step 1: Write the failing test**

Append to `test/sendlog.test.mjs`:

```js
console.log('\n--- B. the app reads its own send history ---');
net.mode = 'online';
let app = globalThis.__loadApp();
net.script.push({ match:'drawing_billing_send_log', method:'GET', status:200,
  body:[{ gid:'g-1', bill_no:'BILLDWG-26-003', send_no:2,
          sent_at:'2026-08-28T09:00:00Z', sent_by_email:'raffy@rsr.test',
          total:'12000.00', change_kind:'decreased', total_delta:'-500.00',
          changed_lines:[{op:'amended',title:'Rudder Detail Plan'}] }] });
const rec = await app.sendLogFor('g-1');
ok('the newest send comes back', rec && rec.send_no === 2, JSON.stringify(rec));
ok('with the sender', rec.sent_by_email === 'raffy@rsr.test');
ok('and the change kind', rec.change_kind === 'decreased');

net.script.push({ match:'drawing_billing_send_log', method:'GET', status:200, body:[] });
ok('a never-sent billing is null', (await app.sendLogFor('g-none')) === null);

net.mode = 'offline';
ok('offline is null, not a throw', (await app.sendLogFor('g-1')) === null);
net.mode = 'online';
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test/sendlog.test.mjs`
Expected: FAIL with `app.sendLogFor is not a function`.

- [ ] **Step 3: Add `sendLogFor`**

Insert immediately after the `groupById` definition:

```js
// The newest send of one billing, or null. Never throws: this decorates the
// UI, and a billing whose history cannot be read must still be sendable.
async function sendLogFor(gid){
  if(!online()||!authed())return null;
  try{
    const r=await sb('drawing_billing_send_log?select=*&gid=eq.'+
      encodeURIComponent(String(gid))+'&order=send_no.desc&limit=1');
    return (r&&r.length)?r[0]:null;
  }catch(e){return null;}
}
```

- [ ] **Step 4: Expose it to the harness**

In `test/harness.mjs`, extend the line that already carries the group helpers:

```js
  allGroups, groupById, groupsFrom, groupOf, groupIdOf, migrateGroups, markGroup,
  GROUP_FIELDS, firstDate, rankOf, sendLogFor,
```

- [ ] **Step 5: Pass `gids` from `lSend`**

In the `payload` object, add the line after `statement_no:issued,`:

```js
      // one send-log row per billing; bill_no is per group and so is its history
      gids:(p.list||[]).map(g=>g&&g.id).filter(Boolean),
```

- [ ] **Step 6: Run the tests and the syntax check**

```bash
sed -n '/^<script>$/,/^<\/script>$/p' index.html | sed '1d;$d' > /tmp/app.js && node --check /tmp/app.js
node test/run.mjs
```
Expected: 0 failed.

- [ ] **Step 7: Commit**

```bash
git add index.html test/harness.mjs test/sendlog.test.mjs
git commit -m "send the gids, and let the app read a billing's send history"
```

---

### Task 4: "Revised \<date\>" on the PDF

**Files:**
- Modify: `index.html:4138-4143` (the `stmtFacts` return)
- Modify: `index.html` — `pdfPlan`, in the header block where `issuedNo` is drawn
- Modify: `index.html:4024` (`pendingSend`) and `:4020` area, to carry the prior send onto the sheet
- Test: `test/sendlog.test.mjs`

**Interfaces:**
- Consumes: `sendLogFor` from Task 3.
- Produces: `facts.sendNo:number` (0 when never sent) and `facts.revisedAt:string` (`''` when never sent), read by `pdfPlan`.

**Why it arrives through `facts`:** `pdfPlan` must stay pure — no DOM, no network. `pdfplan.test.mjs` proves it by mutating `facts` and asserting the output follows, and a plan that fetched its own data would fail that.

- [ ] **Step 1: Write the failing test**

Append to `test/sendlog.test.mjs`:

```js
console.log('\n--- C. a re-sent billing is marked Revised ---');
const baseFacts = { groups:[], list:[], vessels:[], oneVessel:'MV SF CRUISER',
  sub:1000, vat:0, adj:0, grand:1000, terms:30, due:'2026-09-27',
  client:'Seaford', rec:null, from:'2026-08-01', to:'2026-08-31',
  sendNo:0, revisedAt:'' };

let plan = app.pdfPlan(baseFacts, 'BILLDWG-26-003');
ok('a first send carries no Revised line',
   !plan.ops.some(o => /Revised/.test(String(o.text||''))));

plan = app.pdfPlan({ ...baseFacts, sendNo:2, revisedAt:'2026-08-28' }, 'BILLDWG-26-003');
const revOp = plan.ops.find(o => /Revised/.test(String(o.text||'')));
ok('a re-send carries one', !!revOp, JSON.stringify(plan.ops.slice(0,6)));
ok('it names the date', revOp && /28 Aug 2026/.test(revOp.text), revOp && revOp.text);
ok('it stays cp1252-safe',
   revOp && !/[^ -ÿ]/.test(revOp.text), revOp && revOp.text);
ok('the billing number is unchanged — no -R1 suffix',
   plan.ops.some(o => String(o.text||'') === 'BILLDWG-26-003') &&
   !plan.ops.some(o => /-R\d/.test(String(o.text||''))));
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test/sendlog.test.mjs`
Expected: FAIL on "a re-send carries one" — `pdfPlan` ignores `sendNo`.

- [ ] **Step 3: Add the two facts**

In the `stmtFacts` return object, add after `to:$('sTo').value`:

```js
    ,sendNo:Number(stmtSend&&stmtSend.send_no)||0,
    revisedAt:(stmtSend&&stmtSend.sent_at)?String(stmtSend.sent_at).slice(0,10):''
```

and declare the module-level holder beside `pendingSend`:

```js
// the newest send of the billing on the sheet, or null. Filled when the sheet
// opens; stmtFacts only reads it, so pdfPlan stays a pure function of facts.
let stmtSend=null;
```

- [ ] **Step 4: Fill it when the send sheet opens**

In `$('sEmailBtn').onclick`, immediately before `pendingSend={...}`:

```js
  // one billing on the sheet is the case that can be marked Revised; a
  // multi-group statement has no single history to quote
  stmtSend=(list.length===1)?await sendLogFor(list[0].id):null;
```

- [ ] **Step 5: Draw the line in `pdfPlan`**

In the header block, immediately after the op that draws `issuedNo`:

```js
  // A correction keeps its billing number, so this line is the only thing on
  // the document that says the client is holding a second copy.
  if(Number(facts.sendNo)>1&&facts.revisedAt){
    ops.push({p:0,op:'text',x:cRight,y:hy+11,align:'right',size:8,style:'italic',
      text:pdfText('Revised '+fmtDate(facts.revisedAt))});
  }
```

- [ ] **Step 6: Run the tests and the syntax check**

```bash
sed -n '/^<script>$/,/^<\/script>$/p' index.html | sed '1d;$d' > /tmp/app.js && node --check /tmp/app.js
node test/run.mjs
```
Expected: 0 failed, including `pdfplan` — the purity test must still pass.

- [ ] **Step 7: Commit**

```bash
git add index.html test/sendlog.test.mjs
git commit -m "mark a re-sent billing Revised, without touching its number"
```

---

### Task 5: Sender attribution in Monitoring

**Files:**
- Modify: `index.html:1817` (the row-head badges, beside the `mixed` badge)
- Modify: `index.html` — the `render()` group loop, to read a cached send map
- Test: `test/sendlog.test.mjs`

**Interfaces:**
- Consumes: `sendLogFor` from Task 3.
- Produces: `sendMap` — a plain object keyed by gid holding the newest send row, refreshed by `refreshSendMap()` and read synchronously by `render()`.

**Why a cache:** `render()` is synchronous and runs on every keystroke in the filter box. It cannot await. `refreshSendMap()` fills the map once per sync and `render()` reads whatever is there.

- [ ] **Step 1: Write the failing test**

Append to `test/sendlog.test.mjs`:

```js
console.log('\n--- D. Monitoring says who sent it ---');
app.sendMap['g-1'] = { send_no:2, sent_by_email:'raffy@rsr.test', sent_at:'2026-08-28T09:00:00Z' };
const g = app.allGroups()[0];
if (g) {
  app.sendMap[g.id] = { send_no:2, sent_by_email:'raffy@rsr.test', sent_at:'2026-08-28T09:00:00Z' };
  app.render();
  const list = document.getElementById('list').innerHTML;
  ok('the send count shows', /Sent .*2/.test(list), list.slice(0, 400));
  ok('the sender shows', /raffy@rsr\.test/.test(list));
  app.sendMap[g.id] = { send_no:1, sent_by_email:'raffy@rsr.test', sent_at:'2026-08-28T09:00:00Z' };
  app.render();
  ok('a first send is not called a re-send',
     !/Sent .*2/.test(document.getElementById('list').innerHTML));
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test/sendlog.test.mjs`
Expected: FAIL — `app.sendMap` is undefined.

- [ ] **Step 3: Add the map and its refresh**

Beside `sendLogFor`:

```js
// gid -> newest send row. render() is synchronous and cannot await, so it
// reads this and refreshSendMap fills it after a sync.
let sendMap={};
async function refreshSendMap(){
  if(!online()||!authed())return;
  try{
    const r=await sb('drawing_billing_send_log?select=gid,bill_no,send_no,sent_at,sent_by_email&order=send_no.desc');
    const m={};
    (r||[]).forEach(row=>{if(!m[row.gid])m[row.gid]=row;});
    sendMap=m;
  }catch(e){}
}
```

- [ ] **Step 4: Draw the badge**

After the `mixed` badge line in the row head:

```js
        ${(function(s){return s?`<span class="badge sent">Sent ${esc(String(s.send_no))} · ${esc(String(s.sent_by_email||'').split('@')[0])}</span>`:'';})(sendMap[g.id])}
```

and add the style beside `.badge.mixed`:

```css
.badge.sent{color:var(--slate);letter-spacing:.08em}
```

- [ ] **Step 5: Call the refresh after a sync**

In `pull()`, immediately after the call that repaints, add:

```js
  refreshSendMap().then(render);
```

- [ ] **Step 6: Expose to the harness and run**

Add `get sendMap(){return sendMap}, set sendMap(v){sendMap=v}, refreshSendMap,` to the hook, then:

```bash
sed -n '/^<script>$/,/^<\/script>$/p' index.html | sed '1d;$d' > /tmp/app.js && node --check /tmp/app.js
node test/run.mjs
```
Expected: 0 failed.

- [ ] **Step 7: Commit**

```bash
git add index.html test/harness.mjs test/sendlog.test.mjs
git commit -m "show who sent a billing, and how many times"
```

---

### Task 6: Correction-letter placeholders

**Files:**
- Modify: `index.html` — `LETTER_KEYS` and `letterVars`
- Modify: `index.html` — `LETTER_DEFAULT` is **not** changed; corrections use a placeholder the user adds
- Test: `test/sendlog.test.mjs`, `test/letter.test.mjs`

**Interfaces:**
- Consumes: `stmtSend` from Task 4.
- Produces: three new whitelisted placeholders — `{send_no}`, `{revised_note}`, `{change_note}`.

**Why placeholders and not a second template:** `cfg.letter` is shared across devices and empty means `LETTER_DEFAULT`. A second template would need its own shared key, its own empty-means-default rule, and its own migration. Placeholders that resolve to an empty string on a first send cost none of that: the same letter serves both, and an unknown `{token}` is still left standing so a typo shows at review.

- [ ] **Step 1: Write the failing test**

Append to `test/sendlog.test.mjs`:

```js
console.log('\n--- E. the letter can explain a correction ---');
ok('the new keys are whitelisted',
   app.LETTER_KEYS.includes('send_no') &&
   app.LETTER_KEYS.includes('revised_note') &&
   app.LETTER_KEYS.includes('change_note'));

const facts1 = { ...baseFacts, sendNo:0, revisedAt:'' };
let v = app.letterVars(facts1, 'BILLDWG-26-003', null);
ok('a first send has no revised note', v.revised_note === '');
ok('and no change note', v.change_note === '');
ok('send_no reads 1 on a first send', v.send_no === '1');

v = app.letterVars({ ...baseFacts, sendNo:2, revisedAt:'2026-08-28' },
                   'BILLDWG-26-003',
                   { send_no:2, change_kind:'decreased', total_delta:'-500.00',
                     changed_lines:[{op:'amended',title:'Rudder Detail Plan'}] });
ok('a correction says it is revised', /revised/i.test(v.revised_note), v.revised_note);
ok('it keeps the same billing number', !/-R\d/.test(v.revised_note));
ok('the change note names the direction', /decreas/i.test(v.change_note), v.change_note);
ok('and names the amended line', /Rudder Detail Plan/.test(v.change_note), v.change_note);
ok('send_no reads 2', v.send_no === '2');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test/sendlog.test.mjs`
Expected: FAIL on "the new keys are whitelisted".

- [ ] **Step 3: Extend `LETTER_KEYS`**

Add the three names to the existing array literal:

```js
'send_no','revised_note','change_note',
```

- [ ] **Step 4: Build the values in `letterVars`**

Add a third parameter `prior` and, before the return:

```js
  // Empty on a first send, so the same template serves both. A correction
  // keeps its billing number -- the note is what tells the client this is a
  // second copy, because nothing on the number will.
  const n=Number(facts&&facts.sendNo)||0;
  const revised_note=n>1
    ? 'This billing replaces the copy sent on '+fmtDate(facts.revisedAt)+
      '. The billing number is unchanged.'
    : '';
  let change_note='';
  if(n>1&&prior){
    const d=Number(prior.total_delta)||0;
    const dir=d>0?'increased by '+money(Math.abs(d))
             :d<0?'decreased by '+money(Math.abs(d))
             :'is unchanged in total';
    const named=(prior.changed_lines||[]).map(c=>c&&c.title).filter(Boolean);
    change_note='The total has '+dir+
      (named.length?'. Amended: '+named.join(', ')+'.':'.');
  }
```

and add to the returned object:

```js
    send_no:String(n>0?n:1),
    revised_note:revised_note,
    change_note:change_note,
```

- [ ] **Step 5: Pass the prior send at the call site**

In `composeLetter`, thread `stmtSend` through to `letterVars` as the third argument.

- [ ] **Step 6: Run the tests and the syntax check**

```bash
sed -n '/^<script>$/,/^<\/script>$/p' index.html | sed '1d;$d' > /tmp/app.js && node --check /tmp/app.js
node test/run.mjs
```
Expected: 0 failed, including `letter` — the salutation-never-reaches-print assertion must still pass.

- [ ] **Step 7: Document and commit**

Add to `MANUAL-TEST.md` a section 10:

```markdown
## 10. Re-sending a corrected billing

1. Send a billing. Confirm it arrives and Monitoring shows "Sent 1 · <you>".
2. Edit one line's rate. Re-send from the card's Re-send button.
3. The PDF must show the SAME billing number and a "Revised <date>" line.
4. Monitoring must show "Sent 2".
5. If the letter uses {change_note}, the covering letter must name the
   amended line and the direction of the change.
6. In Supabase, `select send_no, change_kind, total_delta from
   drawing_billing_send_log where gid = '<gid>' order by send_no` must show
   two rows, the second `decreased` or `increased`.
```

```bash
git add index.html MANUAL-TEST.md test/sendlog.test.mjs
git commit -m "let the covering letter explain a correction"
```

---

## Self-Review

**Spec coverage.** Snapshot at send time — Task 1 (columns) + Task 2 (write). Same billing number, no `-R1` — asserted in Tasks 4 and 6. Revision number per billing — `send_no`, Task 1, claimed by CAS. Diff on re-send — `billing_line_diff` + `change_kind`/`total_delta`, Task 1, surfaced in Task 6. Correction letters — Task 6. Sender attribution — Tasks 2 and 5. "Revised \<date\>" on the PDF — Task 4. Supabase Auth identity, no passcode — Task 2, asserted by "it passed the sender, not an operator".

**Type consistency.** `sendLogFor` returns a row or `null` in Tasks 3, 4, 5. `facts.sendNo` is a number and `facts.revisedAt` a `YYYY-MM-DD` string in Tasks 4 and 6. `letterVars(facts, no, prior)` keeps the same third parameter in Tasks 5 and 6. The RPC's parameter names in Task 2's payload match Task 1's signature exactly, including `p_cc text[]`.

**Known gaps, deliberate.**
- A **multi-group statement writes one row per gid** but the PDF's Revised line is only drawn for a single-billing sheet (`list.length===1`), because a statement covering three billings has no single history to quote.
- `letter_text` stores the full HTML body, not the plain text. It is what was sent; extracting prose from it is a later problem if it ever matters.
- A line deleted and re-entered reads as removed + added, per the accepted identity limitation.
- This plan **adds to `sqlText()` from day one**, unlike the unbill subsystem, which exists only in the live database (see CLAUDE.md, Known open items).
