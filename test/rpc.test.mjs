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
const SHIM = fs.readFileSync(path.join(ROOT, 'test', 'supabase_shim.sql'), 'utf8');

console.log('\n--- A. the SQL text itself ---');
const count = (s, needle) => s.split(needle).length - 1;
ok('no backtick inside the generated SQL', SQL.indexOf('`') < 0);
ok('no ${ inside the generated SQL', SQL.indexOf('$' + '{') < 0);
ok('receipt table created exactly once', count(SQL, 'create table if not exists billing_drydock_receipt') === 1);
ok('receive_drydock_job defined exactly once', count(SQL, 'create or replace function public.receive_drydock_job') === 1);
ok('receive_drydock_job is in the revoke/grant loop once, and special-cased to service_role once',
   count(SQL, "'public.receive_drydock_job(jsonb)'" + String.fromCharCode(10) + '  ] loop') === 1 &&
   count(SQL, "if f = 'public.receive_drydock_job(jsonb)'") === 1 &&
   count(SQL, "'public.receive_drydock_job(jsonb)'") === 2);
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
  try { await db.exec(SQL); ok('sqlText is idempotent (second run)', true); }
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
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
