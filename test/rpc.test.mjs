// rpc.test.mjs — the generated SQL on a BRAND-NEW database (pglite, real
// Postgres in WASM), then receive_drydock_job exercised as the roles involved.
//   node --experimental-strip-types test/rpc.test.mjs
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || path.join(ROOT, 'index.html');
import { spawnSync } from 'node:child_process';
import os from 'node:os';
let pass = 0, fail = 0;
const ok = (name, cond, extra='') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
// The harness's window/document stubs make pglite take its browser loader,
// so the SQL is extracted in a child process (test/sqltext.mjs) and this
// process never loads the harness.
const gen = spawnSync(process.execPath, [path.join(ROOT, 'test', 'sqltext.mjs'), SRC],
                      { encoding: 'utf8', maxBuffer: 1 << 26 });
if (gen.status !== 0) { console.log('sqltext.mjs failed: ' + gen.stderr); process.exit(1); }
const SQL = gen.stdout;
const SQL_REV_EXPECTED = (SQL.match(/select '([^']+)' as sqltext_applied;/) || [])[1] || '(no stamp)';
const SHIM = fs.readFileSync(path.join(ROOT, 'test', 'supabase_shim.sql'), 'utf8');

console.log('\n--- A. the SQL text itself ---');
const count = (s, needle) => s.split(needle).length - 1;
ok('no backtick inside the generated SQL', SQL.indexOf('`') < 0);
ok('no ${ inside the generated SQL', SQL.indexOf('$' + '{') < 0);
ok('receipt table created exactly once', count(SQL, 'create table if not exists billing_drydock_receipt') === 1);
ok('receive_drydock_job defined exactly once', count(SQL, 'create or replace function public.receive_drydock_job') === 1);
ok('receive_drydock_job is in the revoke/grant loop once, and special-cased to service_role once',
   count(SQL, "'public.receive_drydock_job(jsonb)'" + String.fromCharCode(10) + '  ] loop') === 1 &&
   count(SQL, "if f in ('public.receive_drydock_job(jsonb)',") === 1 &&   // C4: record_billing_send joined it as service_role only
   count(SQL, "'public.receive_drydock_job(jsonb)'") === 2);
// The script ends by naming itself: the Supabase SQL editor shows only the LAST
// statement's result, so a run whose result pane does not read this stamp did
// not run this script's tail (2026-09-11: a full run reported success and
// changed nothing -- residue or a selection in the editor tab). Bump SQL_REV
// with every change to sqlText().
const STAMP_LINE = "select '" + SQL_REV_EXPECTED + "' as sqltext_applied;";
ok('the generated SQL ends with the self-identifying stamp statement', SQL.trimEnd().endsWith(STAMP_LINE), SQL.trimEnd().slice(-120));
ok('the stamp appears exactly once', count(SQL, 'as sqltext_applied') === 1, String(count(SQL, 'as sqltext_applied')));
ok('receipt read policy is rsr_dwg_ prefixed and to authenticated',
   /create policy rsr_dwg_ddreceipt_read on billing_drydock_receipt\s+for select to authenticated/.test(SQL));

console.log('\n--- B. runs on a fresh database, twice ---');
export async function freshDb() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SHIM);
  // The session timezone is NOT Manila on purpose: to_char() on a timestamptz
  // formats in the session zone, and on a PC set to Asia/Manila a missing
  // `at time zone 'Asia/Manila'` printed the right day by accident (a
  // mutation escaped that way). Honolulu is far enough from both UTC and
  // Manila that a UTC day or a session-zone day can never coincide.
  await db.exec("set timezone = 'Pacific/Honolulu'");
  await db.exec(SQL);
  return db;
}
let db;
try { db = await freshDb(); ok('sqlText applies to a brand-new database', true); }
catch (e) { ok('sqlText applies to a brand-new database', false, String(e.message).slice(0, 300)); }
if (db) {
  try {
    const results = await db.exec(SQL);
    ok('sqlText is idempotent (second run)', true);
    const last = results[results.length - 1];
    ok('a full run returns the stamp as its LAST result (what the editor\'s result pane shows)',
       !!last && last.rows && last.rows[0] && last.rows[0].sqltext_applied === SQL_REV_EXPECTED, JSON.stringify(last && last.rows));
  }
  catch (e) { ok('sqlText is idempotent (second run)', false, String(e.message).slice(0, 300)); }
  const fn = await db.query("select to_regprocedure('public.receive_drydock_job(jsonb)') as f");
  ok('receive_drydock_job exists after the script', fn.rows[0].f != null, JSON.stringify(fn.rows[0]));
}

const JOB = (over={}) => Object.assign({
  dispatch_id: '11111111-1111-4111-8111-111111111111',
  draft_id:    '22222222-2222-4222-8222-222222222222',
  source: 'drydocking', project_no: '25-016', vessel: 'MV "SF RISER"',
  client: 'Seaford Shipping Lines, Inc.',
  client_address: '1st Street, North Reclamation Area, Cebu City',
  client_email: 'billing@seaford.test',
  documents: [ { title:'Transmittal', pages:1 }, { title:'Load Line Certificate', pages:1 },
               { title:'Anchor Chain Calibration', pages:2 } ],
  sent_at: '2026-09-09T10:20:00Z', email_provider_id: 'msg_1',
  confirmed_by: 'Raffy J. Ramirez', confirmed_at: '2026-09-09T10:19:00Z',
  completed_by: 'Raffy J. Ramirez', completed_at: '2026-09-09T10:16:25Z'
}, over);
const call = async (d, job) => (await d.query('select public.receive_drydock_job($1::jsonb) as r', [JSON.stringify(job)])).rows[0].r;
const lines = async (d, gid) => (await d.query('select * from drawing_billing where group_id = $1 order by line_no', [gid])).rows;
const wrap = async (fn) => { try { return await fn(); } catch (e) { return { error: String(e.message).slice(0, 160) }; } };
const ymd = v => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

if (db) {
  console.log('\n--- C. first receipt creates one DRAFT DC group, one line per document ---');
  await db.exec("insert into drawing_catalog (name, doc_type, default_rate) values ('Drydocking document', 'DC', 2500)");
  const r1 = await wrap(() => call(db, JOB()));
  ok('created:true with a group id and code', r1.ok === true && r1.created === true && r1.group_id === 'dd-11111111-1111-4111-8111-111111111111' && /^RSR-DC-092026-001$/.test(r1.code), JSON.stringify(r1));
  const l1 = r1.group_id ? await lines(db, r1.group_id) : [];
  ok('three lines, DRAFT, DC, titles in order, qty 1, pages kept, drawing_no null',
     l1.length === 3 && l1.every(r => r.status === 'DRAFT' && r.doc_type === 'DC' && r.qty === 1 && r.drawing_no == null) &&
     l1.map(r => r.drawing_title).join('|') === 'Transmittal|Load Line Certificate|Anchor Chain Calibration' && l1[2].pages === 2,
     JSON.stringify(l1.map(r => [r.drawing_title, r.status, r.qty, r.pages, r.drawing_no])));
  ok('every line carries the same code, client, vessel, Manila bill_date and remarks (group fields)',
     l1.length === 3 && l1.every(r => r.code === r1.code && r.client === 'Seaford Shipping Lines, Inc.' && r.vessel === 'MV "SF RISER"' &&
                   ymd(r.bill_date) === '2026-09-09' &&
                   r.remarks === 'Drydocking documents emailed September 9, 2026, confirmed by Raffy J. Ramirez. Transmittal completed by Raffy J. Ramirez on September 9, 2026. Project 25-016.'),
     JSON.stringify(l1[0] && [l1[0].code, l1[0].bill_date, l1[0].remarks]));
  ok('the receipt row exists with the payload', (await db.query("select count(*)::int as n from billing_drydock_receipt where dispatch_id = $1", [JOB().dispatch_id])).rows[0].n === 1);

  console.log('\n--- D. a retry with the same dispatch_id is a no-op that answers created:false ---');
  const r2 = await wrap(() => call(db, JOB({ vessel: 'CHANGED' })));
  ok('created:false, same group id', r2.ok === true && r2.created === false && r2.group_id === r1.group_id, JSON.stringify(r2));
  const l2 = r1.group_id ? await lines(db, r1.group_id) : [];
  ok('still three lines, vessel untouched', l2.length === 3 && l2[0].vessel === 'MV "SF RISER"');
  ok('one receipt row', (await db.query('select count(*)::int as n from billing_drydock_receipt')).rows[0].n === 1);

  console.log('\n--- E. codes: a second job the same month takes the next number ---');
  const r3 = await wrap(() => call(db, JOB({ dispatch_id: '33333333-3333-4333-8333-333333333333', draft_id: '44444444-4444-4444-8444-444444444444' })));
  ok('second job is -002', r3.created === true && r3.code === 'RSR-DC-092026-002', JSON.stringify(r3));
  await db.exec("insert into drawing_billing (group_id, line_no, code, doc_type, client, drawing_title) values ('hand', 1, 'RSR-DC-092026-007', 'DC', 'X', 'typed by hand')");
  const r4 = await wrap(() => call(db, JOB({ dispatch_id: '55555555-5555-4555-8555-555555555555' })));
  ok('a hand-minted -007 in the cache is respected: next is -008', r4.code === 'RSR-DC-092026-008', JSON.stringify(r4));

  console.log('\n--- F. client: filled when absent, blanks filled, never overwritten ---');
  const cli = async name => (await db.query('select name, address, billing_email from clients where name_canon = $1', [name])).rows[0];
  const c1 = await cli('seaford shipping lines, inc.');
  ok('client inserted with address and billing email', !!c1 && c1.address === JOB().client_address && c1.billing_email === 'billing@seaford.test', JSON.stringify(c1));
  await db.exec("update clients set address = 'Corrected by hand', billing_email = '' where name_canon = 'seaford shipping lines, inc.'");
  await wrap(() => call(db, JOB({ dispatch_id: '66666666-6666-4666-8666-666666666666', client: '  seaford   shipping lines, inc. ', client_address: 'From drydocking', client_email: 'new@seaford.test' })));
  const c2 = await cli('seaford shipping lines, inc.');
  ok('existing address kept, blank billing email filled, no second client row',
     !!c2 && c2.address === 'Corrected by hand' && c2.billing_email === 'new@seaford.test' &&
     (await db.query('select count(*)::int as n from clients')).rows[0].n === 1, JSON.stringify(c2));

  console.log('\n--- G. rate: title match beats the generic row; nothing priced is recorded as unpriced ---');
  await db.exec("insert into drawing_catalog (name, doc_type, default_rate) values ('Load Line Certificate', 'DC', 4000)");
  const r5 = await wrap(() => call(db, JOB({ dispatch_id: '77777777-7777-4777-8777-777777777777' })));
  const l5 = r5.group_id ? await lines(db, r5.group_id) : [];
  ok('Load Line takes its own 4000, the others the generic 2500', l5.length === 3 && Number(l5[1].rate) === 4000 && Number(l5[0].rate) === 2500 && Number(l5[2].rate) === 2500, JSON.stringify(l5.map(r => r.rate)));
  await db.exec("update drawing_catalog set active = false where doc_type = 'DC'");
  const r6 = await wrap(() => call(db, JOB({ dispatch_id: '88888888-8888-4888-8888-888888888888' })));
  const l6 = r6.group_id ? await lines(db, r6.group_id) : [];
  ok('no active DC catalogue row: rate 0 and all three titles reported unpriced',
     l6.length === 3 && l6.every(r => Number(r.rate) === 0) && Array.isArray(r6.unpriced) && r6.unpriced.length === 3, JSON.stringify(r6.unpriced || r6));
  const rec6 = await db.query('select unpriced from billing_drydock_receipt where dispatch_id = $1', ['88888888-8888-4888-8888-888888888888']);
  ok('the receipt records the unpriced titles', rec6.rows.length === 1 && rec6.rows[0].unpriced.length === 3);

  console.log('\n--- I. billable: false lands on the line, absent means true, rate still recorded ---');
  await db.exec("update drawing_catalog set active = true where doc_type = 'DC'");
  const r7 = await wrap(() => call(db, JOB({ dispatch_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    documents: [ { title:'Certificate of Drydocking', pages:1 }, { title:'Drydocking List of Vessel', pages:1, billable:false }, { title:'Docking Plan', billable:true } ] })));
  const l7 = r7.group_id ? await lines(db, r7.group_id) : [];
  ok('List of Vessel line is billable=false, the others true (absent = true)',
     l7.length === 3 && l7.map(r => r.billable).join() === 'true,false,true', JSON.stringify(l7.map(r => [r.drawing_title, r.billable])));
  ok('the no-charge line still records the catalogue rate (the app zeroes the amount; the rate is the record)',
     l7.length === 3 && Number(l7[1].rate) === 2500, l7[1] ? String(l7[1].rate) : 'no line');
  ok('a hardcopy item with no pages inserts with pages null', l7.length === 3 && l7[2].pages === null);

  console.log('\n--- I2. a GROUPED job: the child line remembers its parent ---');
  const rg = await wrap(() => call(db, JOB({ dispatch_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    documents: [ { title:'Transmittal', pages:1 },
                 { title:'Crack Testing Evidence', pages:null },
                 { title:'Propeller Crack Testing Evidence', pages:3, billable:false,
                   parent:'Crack Testing Evidence' } ] })));
  const lg = rg.group_id ? await lines(db, rg.group_id) : [];
  ok('the child stores its parent TITLE while every other line stores null -- a job sent before the drydocking side grouped anything reads exactly as it did',
     lg.length === 3 && lg[0].parent_title == null && lg[1].parent_title == null &&
     lg[2].parent_title === 'Crack Testing Evidence',
     JSON.stringify(lg.map(r => [r.drawing_title, r.parent_title])));
  ok('and the grouping does not touch the charge: the parent bills, the child does not',
     lg.length === 3 && lg[1].billable === true && lg[2].billable === false,
     JSON.stringify(lg.map(r => [r.drawing_title, r.billable])));
  const rgEmpty = await wrap(() => call(db, JOB({ dispatch_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    documents: [ { title:'Transmittal', pages:1, parent:'   ' } ] })));
  const lgEmpty = rgEmpty.group_id ? await lines(db, rgEmpty.group_id) : [];
  ok('a blank parent stores NULL, not an empty string -- the renderer tests one thing, not two',
     lgEmpty.length === 1 && lgEmpty[0].parent_title === null, JSON.stringify(lgEmpty.map(r => r.parent_title)));

  console.log('\n--- J. remarks name the completer only when there is one; dates are Manila days ---');
  const r8 = await wrap(() => call(db, JOB({ dispatch_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', completed_by: '', completed_at: null })));
  const l8 = r8.group_id ? await lines(db, r8.group_id) : [];
  ok('no completer on the payload -> remarks has the emailed sentence and the project only, no dangling "completed by"',
     l8.length === 3 && l8[0].remarks === 'Drydocking documents emailed September 9, 2026, confirmed by Raffy J. Ramirez. Project 25-016.', l8[0] ? l8[0].remarks : JSON.stringify(r8));
  const r9 = await wrap(() => call(db, JOB({ dispatch_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc', completed_by: 'Deck Hand', completed_at: '2026-09-08T22:30:00Z' })));
  const l9 = r9.group_id ? await lines(db, r9.group_id) : [];
  ok('a late-evening UTC completion is the NEXT Manila day in remarks (22:30Z on the 8th -> September 9)',
     l9.length === 3 && /Transmittal completed by Deck Hand on September 9, 2026\./.test(l9[0].remarks), l9[0] ? l9[0].remarks : JSON.stringify(r9));
  const r10 = await wrap(() => call(db, JOB({ dispatch_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbd', completed_by: 'Deck Hand', completed_at: null })));
  const l10 = r10.group_id ? await lines(db, r10.group_id) : [];
  ok('a completer with no time reads "completed by Deck Hand." with no dangling "on"',
     l10.length === 3 && /confirmed by Raffy J\. Ramirez\. Transmittal completed by Deck Hand\. Project 25-016\.$/.test(l10[0].remarks), l10[0] ? l10[0].remarks : JSON.stringify(r10));

  console.log('\n--- K. upgrade: the oldest RPC-bearing script, then the current one over it ---');
  // The fresh+re-run gate proves idempotency, not upgrade: a script that skipped an
  // existing function would pass it. This applies the script from the commit that
  // first shipped receive_drydock_job (no lock, no billable, no completer sentence),
  // then the current script, and reads the body after each.
  {
    const OLDEST = 'd4b6174';
    // the old script must be generated by the OLD commit's own harness: the hook is
    // version-coupled (a name in today's hook that the old index.html lacks throws at load)
    const dir = path.join(os.tmpdir(), 'rsr-billing-oldest');
    fs.mkdirSync(dir, { recursive: true });
    let gitOk = true;
    for (const f of ['index.html', 'test/harness.mjs', 'test/sqltext.mjs']) {
      const r0 = spawnSync('git', ['show', OLDEST + ':' + f], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
      if (r0.status !== 0) { gitOk = false; break; }
      fs.writeFileSync(path.join(dir, path.basename(f)), r0.stdout);
    }
    if (!gitOk) { ok('upgrade: the oldest RPC-bearing index.html, harness and sqltext are available from git', false, 'git show failed'); }
    else {
      const oldGen = spawnSync(process.execPath, [path.join(dir, 'sqltext.mjs'), path.join(dir, 'index.html')], { encoding: 'utf8', maxBuffer: 1 << 26 });
      const OLD = oldGen.stdout;
      ok('upgrade: the oldest script really is older (no lock, no billable, no completer sentence)',
         oldGen.status === 0 && OLD.includes('create or replace function public.receive_drydock_job') &&
         !OLD.includes('pg_advisory_xact_lock') && !OLD.includes("'billable'") && !OLD.includes('Transmittal completed by'), oldGen.stderr);
      const up = new PGlite({ extensions: { pgcrypto } });
      await up.exec(SHIM); await up.exec("set timezone = 'Pacific/Honolulu'");
      const body = async () => (await up.query("select pg_get_functiondef('public.receive_drydock_job(jsonb)'::regprocedure) as d")).rows[0].d;
      await up.exec(OLD);
      ok('upgrade: after the oldest script the live-style body lacks the lock and the completer sentence',
         !(await body()).includes('pg_advisory_xact_lock') && !(await body()).includes('Transmittal completed by'));
      let err = null;
      try { await up.exec(SQL); } catch (e) { err = String(e.message).slice(0, 200); }
      const b2 = err ? '' : await body();
      ok('upgrade: the current script over it runs clean and REPLACES the body (lock, billable, completer sentence all present)',
         err === null && b2.includes('pg_advisory_xact_lock') && b2.includes("'billable'") && b2.includes('Transmittal completed by'), err || 'body unchanged');
      const priv = await up.query("select has_function_privilege('anon', 'public.receive_drydock_job(jsonb)', 'execute') as a, has_function_privilege('service_role', 'public.receive_drydock_job(jsonb)', 'execute') as s");
      ok('upgrade: grants re-applied on the upgraded function (anon false, service_role true)', priv.rows[0].a === false && priv.rows[0].s === true, JSON.stringify(priv.rows[0]));
    }
  }

  console.log('\n--- H. refused payloads and roles ---');
  const bad = await wrap(() => call(db, JOB({ dispatch_id: '99999999-9999-4999-8999-999999999999', documents: [] })));
  ok('empty documents is refused, nothing written', bad.ok === false && /documents/.test(bad.reason) &&
     (await db.query("select count(*)::int as n from billing_drydock_receipt where dispatch_id = '99999999-9999-4999-8999-999999999999'")).rows[0].n === 0, JSON.stringify(bad));
  const bad2 = await wrap(() => call(db, JOB({ dispatch_id: '99999999-9999-4999-8999-999999999998', client: '  ' })));
  ok('blank client is refused', bad2.ok === false && /client/.test(bad2.reason), JSON.stringify(bad2));
  for (const role of ['anon', 'authenticated']) {
    let refused = false, msg = '';
    try { await db.exec('set role ' + role); await call(db, JOB({ dispatch_id: '99999999-9999-4999-8999-999999999997' })); }
    catch (e) { msg = e.message; refused = /permission denied/i.test(e.message); }
    finally { await db.exec('reset role'); }
    ok(role + ' cannot execute receive_drydock_job', refused, msg.slice(0, 120));
  }
  let svc = false, svcMsg = '';
  try { await db.exec('set role service_role'); svc = (await call(db, JOB({ dispatch_id: '99999999-9999-4999-8999-999999999996' }))).ok === true; }
  catch (e) { svcMsg = e.message; }
  finally { await db.exec('reset role'); }
  ok('service_role can execute it', svc, svcMsg.slice(0, 120));

  /* L sits at the END: every job here takes a billing number, and the
     sections above count them. */
  console.log('\n--- L. a job RE-SENT while an earlier bill for its draft is unpaid ---');
  const DRAFT_R = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  // the ANSWER's resend_of, or null when it is missing -- never a throw: a crash here
  // skips every later assertion in this file instead of failing one (mutation R6)
  const ro = r => (r && Array.isArray(r.resend_of)) ? r.resend_of : null;
  const rs = async id => (await db.query('select resend_of, resend_kept_at, resend_kept_by from billing_drydock_receipt where dispatch_id = $1', [id])).rows[0];
  const s1 = await wrap(() => call(db, JOB({ dispatch_id: 'e0000000-0000-4000-8000-000000000001', draft_id: DRAFT_R })));
  ok('the first send for a draft names no earlier bill',
     s1.created === true && JSON.stringify(ro(s1)) === '[]' &&
     (await rs('e0000000-0000-4000-8000-000000000001')).resend_of.length === 0, JSON.stringify(s1));
  const s2 = await wrap(() => call(db, JOB({ dispatch_id: 'e0000000-0000-4000-8000-000000000002', draft_id: DRAFT_R })));
  ok('a second send for the SAME draft while the first bill is DRAFT still creates its bill -- a warning, never a block',
     s2.created === true && (await lines(db, s2.group_id)).length === 3, JSON.stringify(s2));
  ok('...and names the earlier bill, in its answer AND on its receipt',
     JSON.stringify(s2.resend_of) === JSON.stringify([s1.group_id]) &&
     JSON.stringify((await rs('e0000000-0000-4000-8000-000000000002')).resend_of) === JSON.stringify([s1.group_id]),
     JSON.stringify({ s2: s2.resend_of, receipt: (await rs('e0000000-0000-4000-8000-000000000002')) }));
  ok('the earlier receipt is not rewritten -- the pair is found from the newer side',
     (await rs('e0000000-0000-4000-8000-000000000001')).resend_of.length === 0);
  const again = await wrap(() => call(db, JOB({ dispatch_id: 'e0000000-0000-4000-8000-000000000002', draft_id: DRAFT_R })));
  ok('a retry of the second send is still created:false and leaves its record alone',
     again.created === false && JSON.stringify((await rs('e0000000-0000-4000-8000-000000000002')).resend_of) === JSON.stringify([s1.group_id]),
     JSON.stringify(again));
  const other = await wrap(() => call(db, JOB({ dispatch_id: 'e0000000-0000-4000-8000-000000000003', draft_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })));
  ok('an unpaid bill from ANOTHER draft is never named', other.created === true && JSON.stringify(ro(other)) === '[]', JSON.stringify(other));

  // a bill with ONE line paid and the rest BILLED is still unpaid (a card takes its least advanced line,
  // and BILLED is sent-not-paid -- the bill most worth a warning)
  await db.query("update drawing_billing set status = 'PAID' where group_id = $1 and line_no = 1", [s1.group_id]);
  await db.query("update drawing_billing set status = 'BILLED' where group_id = $1 and line_no <> 1", [s1.group_id]);
  await db.query("update drawing_billing set status = 'PAID' where group_id = $1", [s2.group_id]);
  const s4 = await wrap(() => call(db, JOB({ dispatch_id: 'e0000000-0000-4000-8000-000000000004', draft_id: DRAFT_R })));
  ok('a third send names only the bills still unpaid: a PARTLY paid, otherwise BILLED bill counts, a fully PAID one does not',
     JSON.stringify(s4.resend_of) === JSON.stringify([s1.group_id]), JSON.stringify(s4.resend_of));
  // the operator voids the old bills: their lines are deleted, the receipts stay
  // C4: a billed or paid line can no longer be deleted directly (that was the
  // two-tap bypass, Mark paid -> Delete). Voiding goes through unbill_group,
  // which sets rsr.unbilling for its own transaction; the same flag here
  // stands in for that path so the section keeps modelling a voided bill.
  await db.exec("select set_config('rsr.unbilling', '1', false)");
  await db.query("update drawing_billing set status = 'DRAFT', billed_date = null, paid_date = null where group_id = any($1)", [[s1.group_id, s4.group_id]]);
  await db.exec("select set_config('rsr.unbilling', '', false)");
  await db.query('delete from drawing_billing where group_id = any($1)', [[s1.group_id, s4.group_id]]);   // a DRAFT deletes, as in the app
  const s5 = await wrap(() => call(db, JOB({ dispatch_id: 'e0000000-0000-4000-8000-000000000005', draft_id: DRAFT_R })));
  ok('a bill whose lines were deleted (voided) is never named, though its receipt remains',
     s5.created === true && JSON.stringify(ro(s5)) === '[]', JSON.stringify(s5));

  // Keep both
  const s6 = await wrap(() => call(db, JOB({ dispatch_id: 'e0000000-0000-4000-8000-000000000006', draft_id: DRAFT_R })));
  ok('with the fifth bill unpaid, the sixth names it', JSON.stringify(s6.resend_of) === JSON.stringify([s5.group_id]), JSON.stringify(s6.resend_of));
  // C4: Keep both is for billing accounts; the kept-by email below is one
  await db.query("insert into billing_users (email, role) values ('summer@rsr.test', 'staff') on conflict do nothing");
  const keep = async (gid, role) => {
    try {
      if (role) { await db.exec('set role ' + role); await db.exec("select set_config('request.jwt.claim.email', 'summer@rsr.test', false)"); }
      return (await db.query('select public.keep_drydock_resend($1) as r', [gid])).rows[0].r;
    } catch (e) { return { error: String(e.message).slice(0, 120) }; }
    finally { if (role) { await db.exec('reset role'); await db.exec("select set_config('request.jwt.claim.email', '', false)"); } }
  };
  const anonKeep = await keep(s5.group_id, 'anon');
  ok('anon cannot Keep both', /permission denied/i.test(anonKeep.error || ''), JSON.stringify(anonKeep));
  const k1 = await keep(s5.group_id, 'authenticated');
  const rk6 = await rs('e0000000-0000-4000-8000-000000000006');
  ok('a signed-in user keeps both FROM THE OLDER card: the receipt naming it is stamped with who and when',
     k1.ok === true && k1.kept === 1 && k1.by === 'summer@rsr.test' && rk6.resend_kept_at != null && rk6.resend_kept_by === 'summer@rsr.test',
     JSON.stringify({ k1, rk6 }));
  ok('...and Keep both changes no bill: both still have their lines, both still DRAFT',
     (await lines(db, s5.group_id)).every(r => r.status === 'DRAFT') && (await lines(db, s6.group_id)).every(r => r.status === 'DRAFT') &&
     (await lines(db, s5.group_id)).length === 3 && (await lines(db, s6.group_id)).length === 3);
  const k2 = await keep(s5.group_id, 'authenticated');
  ok('keeping again settles nothing more and does not move the stamp', k2.ok === true && k2.kept === 0 &&
     String((await rs('e0000000-0000-4000-8000-000000000006')).resend_kept_at) === String(rk6.resend_kept_at), JSON.stringify(k2));
  const s7 = await wrap(() => call(db, JOB({ dispatch_id: 'e0000000-0000-4000-8000-000000000007', draft_id: DRAFT_R })));
  const k3 = await keep(s7.group_id, 'authenticated');
  ok('keeping from the NEWER card stamps its own receipt only, and a receipt with nothing to warn about is never stamped',
     (ro(s7) || []).length === 2 && k3.kept === 1 && (await rs('e0000000-0000-4000-8000-000000000007')).resend_kept_at != null &&
     (await rs('e0000000-0000-4000-8000-000000000001')).resend_kept_at == null, JSON.stringify({ s7: ro(s7), k3 }));
  const priv = await db.query("select has_function_privilege('anon', 'public.keep_drydock_resend(text)', 'execute') as a, has_function_privilege('authenticated', 'public.keep_drydock_resend(text)', 'execute') as u");
  ok('keep_drydock_resend: anon holds no EXECUTE, authenticated does', priv.rows[0].a === false && priv.rows[0].u === true, JSON.stringify(priv.rows[0]));
}

if (db) {
  console.log('\n--- M. billing roles (C4): who a billing account is, and what staff may not touch ---');
  /* The audit's C4: every policy was `to authenticated using (true)`, so any
     account on the SHARED Supabase project (the kiosk logins carmen@ and
     mandaue@) could read every client and rewrite the bank details printed on
     every bill. Membership lives in billing_users; role 'admin' or 'staff'.
     admin@ = admin, secretary@ = staff (owner's decision 2026-09-18). Every
     probe below runs AS the authenticated role with a JWT email set, against
     the real generated SQL -- policies are exercised, never read. */
  const asRole = async (email, sql, params) => {
    try {
      await db.exec('set role authenticated');
      await db.exec("select set_config('request.jwt.claim.email', '" + email + "', false), set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000" + (email.length % 10) + "', false)");
      const r = await db.query(sql, params); return { rows: r.rows, affected: r.affectedRows };
    } catch (e) { return { error: String(e.message).slice(0, 160) }; }
    finally { await db.exec('reset role'); await db.exec("select set_config('request.jwt.claim.email', '', false)"); }
  };
  const ADMIN = 'owner@rsr.test', STAFF = 'wife@rsr.test', KIOSK = 'kiosk@rsr.test';
  const refused = r => !!(r.error && /permission denied|row-level security|billing account required|violates|forward|unbill_group|frozen|cannot be deleted/i.test(r.error)) || (r.affected === 0 && !(r.rows && r.rows.length));

  // table + seed
  const tbl = await db.query("select to_regclass('public.billing_users') t, (select relrowsecurity from pg_class where oid = to_regclass('public.billing_users')) rls");
  ok('M1 billing_users exists with RLS on', tbl.rows[0].t != null && tbl.rows[0].rls === true, JSON.stringify(tbl.rows[0]));
  await db.query('insert into billing_senders (email) values ($1) on conflict do nothing', [STAFF]);
  await db.exec(SQL);   // the seed: every allow-listed sender becomes a billing user (staff), nobody is removed
  const seeded = await db.query('select email, role from billing_users order by email');
  ok('M2 re-running the script seeds billing_users from billing_senders as staff (one run: seed + policies together)',
     seeded.rows.some(r => r.email === STAFF && r.role === 'staff'), JSON.stringify(seeded.rows));
  await db.query("insert into billing_users (email, role) values ($1, 'admin') on conflict (email) do update set role = 'admin'", [ADMIN]);
  const roleCheck = await wrap(() => db.query("insert into billing_users (email, role) values ('x@rsr.test', 'owner')"));
  ok('M3 role is constrained to admin|staff', /violates check|invalid input|check constraint/i.test(roleCheck.error || ''), JSON.stringify(roleCheck));

  // own-row read, and the helpers
  const own = await asRole(STAFF, 'select email, role from billing_users');
  ok('M4 a member reads exactly its OWN row (the app learns its role from it)', own.rows && own.rows.length === 1 && own.rows[0].role === 'staff', JSON.stringify(own));
  const none = await asRole(KIOSK, 'select email, role from billing_users');
  ok('M5 a non-member reads [] -- the app\'s "not a billing account" signal', none.rows && none.rows.length === 0, JSON.stringify(none));
  const fns = await asRole(STAFF, 'select public.rsr_billing_user() u, public.rsr_billing_admin() a, public.rsr_billing_role() r');
  ok('M6 helpers: staff is a user, not an admin', fns.rows && fns.rows[0].u === true && fns.rows[0].a === false && fns.rows[0].r === 'staff', JSON.stringify(fns));

  // a bill to probe with
  const gid = 'role-probe-1';
  await db.query("insert into drawing_billing (group_id, line_no, code, doc_type, bill_date, client, vessel, drawing_title, qty, rate, status) values ($1, 1, 'RSR-DW-092026-090', 'DW', '2026-09-18', 'Probe Co', 'MV PROBE', 'Plan A', 1, 2500, 'DRAFT')", [gid]);
  await db.query("insert into clients (name, billing_email) values ('Probe Co', 'ap@probe.test') on conflict do nothing");
  await db.query("insert into app_settings (key, value) values ('payment', '{\"payee\":\"RSR\"}') on conflict (key) do update set value = excluded.value");
  await db.query("insert into app_settings (key, seq_year, seq_n) values ('billseq:DW', '26', 7) on conflict (key) do update set seq_year = '26', seq_n = 7");

  // KIOSK (non-member): nothing
  ok('M7 non-member reads no bills', (await asRole(KIOSK, 'select count(*)::int n from drawing_billing')).rows[0].n === 0);
  ok('M8 non-member reads no clients', (await asRole(KIOSK, 'select count(*)::int n from clients')).rows[0].n === 0);
  ok('M9 non-member reads no settings, no send log, no receipts',
     (await asRole(KIOSK, 'select count(*)::int n from app_settings')).rows[0].n === 0 &&
     (await asRole(KIOSK, 'select count(*)::int n from drawing_billing_send_log')).rows[0].n === 0 &&
     (await asRole(KIOSK, 'select count(*)::int n from billing_drydock_receipt')).rows[0].n === 0);
  ok('M10 non-member cannot insert a bill', refused(await asRole(KIOSK, "insert into drawing_billing (group_id, line_no, code, doc_type, bill_date, client, vessel, drawing_title, qty, rate, status) values ('k', 1, 'X', 'DW', '2026-09-18', 'c', 'v', 't', 1, 1, 'DRAFT')")));
  const kPay = await asRole(KIOSK, "update app_settings set value = '{\"payee\":\"ATTACKER\"}' where key = 'payment'");
  ok('M11 non-member cannot rewrite the payment details (the audit\'s bank-account rewrite)', refused(kPay) && (await db.query("select value->>'payee' p from app_settings where key='payment'")).rows[0].p === 'RSR', JSON.stringify(kPay));
  ok('M12 non-member cannot touch the drawings bucket', refused(await asRole(KIOSK, "insert into storage.objects (bucket_id, name) values ('drawings', 'k.pdf')")));
  ok('M13 non-member cannot call record_billing_send (service_role only now) nor keep_drydock_resend',
     /permission denied/i.test((await asRole(KIOSK, "select public.record_billing_send('g','B','to@x.test')")).error || '') &&
     /billing account required/i.test((await asRole(KIOSK, "select public.keep_drydock_resend('g')")).error || ''));
  ok('M14 even a MEMBER cannot call record_billing_send: only the Edge Function\'s service key may write the send log',
     /permission denied/i.test((await asRole(ADMIN, "select public.record_billing_send('g','B','to@x.test')")).error || ''));

  // STAFF: everything needed to bill, and nothing admin
  ok('M15 staff reads bills and clients', (await asRole(STAFF, 'select count(*)::int n from drawing_billing')).rows[0].n >= 1 && (await asRole(STAFF, 'select count(*)::int n from clients')).rows[0].n >= 1);
  ok('M16 staff can create a bill and edit a client', !(await asRole(STAFF, "insert into drawing_billing (group_id, line_no, code, doc_type, bill_date, client, vessel, drawing_title, qty, rate, status) values ('s1', 1, 'RSR-DW-092026-091', 'DW', '2026-09-18', 'Probe Co', 'MV S', 'Plan S', 1, 2500, 'DRAFT')")).error &&
     (await asRole(STAFF, "update clients set email_cc = 'cc@probe.test' where name = 'Probe Co'")).affected === 1);
  const claim = await asRole(STAFF, "update app_settings set seq_n = 8 where key = 'billseq:DW' and seq_year = '26' and seq_n = 7");
  ok('M17 staff can CLAIM a billing number (the compare-and-swap +1)', claim.affected === 1, JSON.stringify(claim));
  const manual = await asRole(STAFF, "update app_settings set seq_n = 12 where key = 'billseq:DW' and seq_year = '26' and seq_n = 8");
  ok('M18 staff can raise the counter to a hand-typed number (forward, any step)', manual.affected === 1, JSON.stringify(manual));
  const reset = await asRole(STAFF, "update app_settings set seq_n = 1 where key = 'billseq:DW'");
  ok('M19 staff cannot RESET the counter backwards (trigger: a non-admin only moves a counter forward)', refused(reset) && (await db.query("select seq_n from app_settings where key='billseq:DW'")).rows[0].seq_n === 12, JSON.stringify(reset));
  const sPay = await asRole(STAFF, "update app_settings set value = '{\"payee\":\"WIFE\"}' where key = 'payment'");
  ok('M20 staff cannot change payment details, letter or types (admin-only settings keys)', refused(sPay) && refused(await asRole(STAFF, "insert into app_settings (key, value) values ('letter', '{\"text\":\"x\"}')")), JSON.stringify(sPay));
  ok('M21 staff reads the catalogue but cannot add or reprice an item', (await asRole(STAFF, 'select count(*)::int n from drawing_catalog')).rows[0].n >= 1 &&
     refused(await asRole(STAFF, "update drawing_catalog set default_rate = 1 where doc_type = 'DC'")) && refused(await asRole(STAFF, "insert into drawing_catalog (name, doc_type) values ('Sneaky', 'DW')")));
  ok('M22 staff can read the send log and receipts', !!(await asRole(STAFF, 'select count(*)::int n from drawing_billing_send_log')).rows && !!(await asRole(STAFF, 'select count(*)::int n from billing_drydock_receipt')).rows);

  // ADMIN: the fenced things
  ok('M23 admin changes payment details and the catalogue rate', (await asRole(ADMIN, "update app_settings set value = '{\"payee\":\"RSR Engineering\"}' where key = 'payment'")).affected === 1 &&
     (await asRole(ADMIN, "update drawing_catalog set default_rate = 2600 where doc_type = 'DC'")).affected >= 1);
  ok('M24 admin may reset a counter', (await asRole(ADMIN, "update app_settings set seq_n = 0 where key = 'billseq:DW'")).affected === 1);

  // guards, run as staff (the app's own path)
  await db.query("update drawing_billing set status = 'BILLED', billed_date = '2026-09-18', bill_no = 'BILLDWG-26-090' where group_id = $1", [gid]).catch(() => {});
  ok('M25 guard: BILLED -> PAID (mark paid) and PAID -> BILLED (reopen) are allowed',
     (await asRole(STAFF, "update drawing_billing set status = 'PAID', paid_date = '2026-09-19' where group_id = $1", [gid])).affected === 1 &&
     (await asRole(STAFF, "update drawing_billing set status = 'BILLED' where group_id = $1", [gid])).affected === 1);
  ok('M26 guard: BILLED -> DRAFT and PAID -> DRAFT are refused outside unbill_group (the two-tap bypass is closed)',
     refused(await asRole(STAFF, "update drawing_billing set status = 'DRAFT' where group_id = $1", [gid])) &&
     (await asRole(STAFF, "update drawing_billing set status = 'PAID' where group_id = $1", [gid])).affected === 1 &&
     refused(await asRole(STAFF, "update drawing_billing set status = 'DRAFT' where group_id = $1", [gid])));
  ok('M27 guard: rate, qty, billable and title are frozen on a non-DRAFT line; remarks/invoice stay editable',
     refused(await asRole(STAFF, 'update drawing_billing set rate = 1 where group_id = $1', [gid])) &&
     refused(await asRole(STAFF, 'update drawing_billing set qty = 9 where group_id = $1', [gid])) &&
     refused(await asRole(STAFF, "update drawing_billing set drawing_title = 'Other' where group_id = $1", [gid])) &&
     (await asRole(STAFF, "update drawing_billing set remarks = 'ok', invoice_no = 'INV-1' where group_id = $1", [gid])).affected === 1);
  ok('M28 guard: a PAID or BILLED line cannot be deleted; a DRAFT line can',
     refused(await asRole(STAFF, 'delete from drawing_billing where group_id = $1', [gid])) &&
     (await asRole(STAFF, "delete from drawing_billing where group_id = 's1'")).affected === 1);

  // the captured unbill subsystem is in the script now, and unbill_group still walks a bill back
  const ops = await db.query("select to_regclass('public.billing_unbill_operator') o, to_regclass('public.billing_unbill_throttle') t, to_regclass('public.drawing_billing_unbill_log') l, to_regprocedure('public.unbill_group(text,text,text)') f, to_regprocedure('public.resolve_unbill_operator(text)') r");
  ok('M29 the unbill subsystem (3 tables, 4 RPCs, 2 guards) is created by the script -- a second project can be stood up from the repo', Object.values(ops.rows[0]).every(v => v != null), JSON.stringify(ops.rows[0]));
  await db.query("insert into billing_unbill_operator (name, passcode_hash) values ('Wife', extensions.crypt('654321', extensions.gen_salt('bf', 4)))");
  // the app offers Unbill on a BILLED bill (a PAID one is reopened first); M26 left the probe PAID
  await asRole(STAFF, "update drawing_billing set status = 'BILLED' where group_id = $1", [gid]);
  const ub = await asRole(STAFF, "select public.unbill_group($1, '654321', 'probe') r", [gid]);
  ok('M30 staff unbills by passcode through unbill_group (allowed by decision) and the row is DRAFT again', !!(ub.rows && ub.rows[0].r.ok === true) && (await db.query('select status from drawing_billing where group_id=$1', [gid])).rows[0].status === 'DRAFT', JSON.stringify(ub));
  ok('M31 a non-member cannot unbill even with a valid passcode', /billing account required/i.test((await asRole(KIOSK, "select public.unbill_group($1, '654321', 'probe') r", [gid])).error || ''));
  const wrong = await asRole(STAFF, "select public.unbill_group($1, '000000', 'probe') r", [gid]);
  ok('M32 the wrong passcode is refused with the server\'s own words', !!(wrong.rows && wrong.rows[0].r.reason === 'Wrong passcode'), JSON.stringify(wrong));

  // privileges as facts
  const priv = await db.query("select " +
    "has_function_privilege('anon','public.rsr_dwg_block_unbill()','execute') a1, " +
    "has_function_privilege('anon','public.rsr_dwg_block_delete_billed()','execute') a2, " +
    "has_function_privilege('anon','public.rsr_touch_updated_at()','execute') a3, " +
    "has_function_privilege('authenticated','public.record_billing_send(text,text,text,text[],uuid,text,text,text,numeric)','execute') rb_auth, " +
    "has_function_privilege('service_role','public.record_billing_send(text,text,text,text[],uuid,text,text,text,numeric)','execute') rb_svc, " +
    "has_function_privilege('anon','public.rsr_billing_user()','execute') ru_anon, " +
    "has_function_privilege('authenticated','public.rsr_billing_user()','execute') ru_auth");
  ok('M33 trigger functions hold no anon EXECUTE; record_billing_send is service_role only; the role helpers execute for authenticated, not anon',
     priv.rows[0].a1 === false && priv.rows[0].a2 === false && priv.rows[0].a3 === false && priv.rows[0].rb_auth === false && priv.rows[0].rb_svc === true && priv.rows[0].ru_anon === false && priv.rows[0].ru_auth === true, JSON.stringify(priv.rows[0]));
  ok('M34 the script still applies a second time after all of this (idempotent with the new objects)', !(await wrap(() => db.exec(SQL))).error);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
