import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || path.join(ROOT, 'index.html');
const FN_SRC = path.join(ROOT, 'supabase', 'functions', 'send-statement', 'index.ts');
import { net, mnlToday, codeStamp, monthFirst } from './harness.mjs';
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (name, cond, extra='') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const el = id => document.getElementById(id);
const html = fs.readFileSync(SRC, 'utf8');
const KEYS = ['rsr_dwg_cfg_v1','rsr_dwg_rows_v1','rsr_dwg_queue_v1','rsr_dwg_session_v1',
              'rsr_dwg_catalog_v1','rsr_dwg_clients_v1','rsr_dwg_shared_v1'];
// Fixtures ride the Manila clock, never a written-out month: a code is
// stamped with the month the sheet was opened in, so a literal agrees with
// the app for one month a year. See the note in harness.mjs.
const TODAY = mnlToday();
const MM = codeStamp();                 // MMYYYY, as it appears in a code
const DW1 = 'RSR-DW-' + MM + '-001';
const reset = (rows) => {
  KEYS.forEach(k => globalThis.localStorage.removeItem(k));
  globalThis.localStorage.setItem('rsr_dwg_cfg_v1', JSON.stringify({ seededDW:true }));
  if (rows) globalThis.localStorage.setItem('rsr_dwg_rows_v1', JSON.stringify(rows));
  return globalThis.__loadApp();
};
const batch = (client, vessel, date, rate) => {
  el('eClient').value = client; el('eVessel').value = vessel;
  el('eDate').value = date;     el('eRate').value = rate;
};
net.mode = 'offline';
let app = reset();

console.log('\n--- A. one code for the whole billing ---');
app.openEntry(null, 'DW');
batch('Seaford', 'MV SF Voyager', TODAY, '10000');
app.mlines[0].title = 'General Arrangement Plan';
app.mlines.push({ id:null, title:'Construction Plan', ref:'', qty:1, rate:'' });
app.mlines.push({ id:null, title:'Capacity Plan',     ref:'', qty:1, rate:'' });
app.mlines.push({ id:null, title:'Shell Expansion',   ref:'', qty:1, rate:'' });
app.renderML();
await el('eSave').onclick();
ok('four line records created', app.rows.length === 4, String(app.rows.length));
const codes = new Set(app.rows.map(r => r.code));
ok('all four share one code', codes.size === 1, [...codes].join(','));
ok('the code is the next in the run', [...codes][0] === DW1, [...codes][0]);
ok('all share one group id', new Set(app.rows.map(app.groupIdOf)).size === 1);
ok('lines keep their own record ids', new Set(app.rows.map(r => r.id)).size === 4);
ok('lines carry no separate code of their own',
   app.rows.every(r => r.code === [...codes][0]));

console.log('\n--- B. the group is one card with a group total ---');
let gs = app.allGroups();
ok('one group', gs.length === 1, String(gs.length));
ok('line count on the group', gs[0].count === 4, String(gs[0].count));
ok('group total is the sum', gs[0].total === 40000, String(gs[0].total));
ok('client and vessel on the group',
   gs[0].client === 'Seaford' && gs[0].vessel === 'MV SF Voyager');
app.render();
ok('card shows the shared code once',
   el('list').innerHTML.split(DW1).length - 1 === 1,
   String(el('list').innerHTML.split(DW1).length - 1));
ok('card shows the group total', el('list').innerHTML.includes('40,000'));
ok('card shows the line count', /4 items/.test(el('list').innerHTML));

console.log('\n--- C. expandable to the lines ---');
ok('lines hidden by default', !/class="glines"/.test(el('list').innerHTML));
app.expanded = { [gs[0].id]: true };
app.render();
const open = el('list').innerHTML;
ok('lines shown when expanded', /class="glines"/.test(open));
ok('lines numbered 1.0 upward', open.includes('>1.0<') && open.includes('>4.0<'));
ok('each line title listed',
   open.includes('General Arrangement Plan') && open.includes('Shell Expansion'));
app.expanded = {};

console.log('\n--- D. the monthly run counts billings, not lines ---');
ok('next code is 002, not 005', app.nextCode(TODAY,'DW') === 'RSR-DW-' + MM + '-002',
   app.nextCode(TODAY,'DW'));

console.log('\n--- E. status acts on the group ---');
gs = app.allGroups();
app.markGroup(gs[0].id, 'BILLED');
ok('every line moved to BILLED', app.rows.every(r => r.status === 'BILLED'));
ok('every line stamped billed_date', app.rows.every(r => !!r.billed_date));
app.markGroup(gs[0].id, 'PAID');
ok('every line moved to PAID', app.rows.every(r => r.status === 'PAID'));
app.markGroup(gs[0].id, 'DRAFT');
ok('unbilling clears both dates',
   app.rows.every(r => r.status === 'DRAFT' && !r.billed_date && !r.paid_date));

console.log('\n--- F. totals count group amounts ---');
app.render();
ok('unbilled total is the group total', el('tDraft').textContent.includes('40,000'),
   el('tDraft').textContent);
ok('counted as one billing, not four', el('cDraft').textContent === '1 billing',
   el('cDraft').textContent);

console.log('\n--- G. catalog picker makes one group ---');
app = reset();
for (const n of ['Docking Plan','Hull Survey','Tailshaft Cert'])
  await app.catSave({ name:n, doc_type:'DC', drawing_no:'', default_rate:2000,
                      sort_order:0, active:true }, true);
el('kClient').value = 'Seaford'; el('kVessel').value = 'MV X';
el('kDate').value = TODAY; el('kRate').value = '2000'; el('kType').value = 'DC';
app.openCat('DC');
await el('kCommit').onclick();
ok('three lines', app.rows.length === 3, String(app.rows.length));
ok('one group', app.allGroups().length === 1, String(app.allGroups().length));
ok('one shared code', new Set(app.rows.map(r => r.code)).size === 1);
ok('code is a DC code', app.rows[0].code.startsWith('RSR-DC-'), app.rows[0].code);

console.log('\n--- H. a single quick add is a group of one ---');
app = reset();
app.openEntry(null, 'UT');
batch('Seaford', '', TODAY, '5000');
app.mlines[0].title = 'UTG Report';
await el('eSave').onclick();
const g1 = app.allGroups()[0];
ok('one group of one line', app.allGroups().length === 1 && g1.count === 1);
ok('still gets a tracking code', g1.code === 'RSR-UT-' + MM + '-001', g1.code);

console.log('\n--- I. editing a DRAFT can add and remove lines ---');
app = reset();
app.openEntry(null, 'DW');
batch('Seaford', '', TODAY, '1000');
app.mlines[0].title = 'Keep Me';
app.mlines.push({ id:null, title:'Remove Me', ref:'', qty:1, rate:'' });
app.renderML();
await el('eSave').onclick();
const gid = app.allGroups()[0].id;
const keptId = app.rows.find(r => r.drawing_title === 'Keep Me').id;

app.openEntry(gid);
ok('lines loaded for editing', app.mlines.length === 2, String(app.mlines.length));
ok('existing lines carry their record id', app.mlines.every(l => !!l.id));
ok('lines unlocked while DRAFT', app.multiLocked === false);
ok('add line enabled', el('mlAdd').disabled === false);
app.mlines = app.mlines.filter(l => l.title !== 'Remove Me');
app.mlines.push({ id:null, title:'Brand New Line', ref:'', qty:1, rate:'2500' });
app.renderML();
await el('eSave').onclick();
const g2 = app.allGroups()[0];
ok('still one group', app.allGroups().length === 1);
ok('removed line is gone', !app.rows.some(r => r.drawing_title === 'Remove Me'));
ok('added line is there', app.rows.some(r => r.drawing_title === 'Brand New Line'));
ok('kept line kept its record id', app.rows.some(r => r.id === keptId));
ok('code unchanged by the edit', g2.code === DW1, g2.code);
ok('new line joined the same group', new Set(app.rows.map(app.groupIdOf)).size === 1);

console.log('\n--- J. lines lock once BILLED ---');
app.markGroup(gid, 'BILLED');
app.openEntry(gid);
ok('lines locked', app.multiLocked === true);
ok('add line disabled', el('mlAdd').disabled === true);
ok('lock notice shown', el('mlLock').hidden === false);
ok('catalog promotion hidden', el('mlToCatWrap').hidden === true);
ok('inputs rendered disabled', /data-mlf="title"[^>]*disabled/.test(el('mlList').innerHTML),
   el('mlList').innerHTML.slice(0, 240));
const before = app.rows.length;
app.mlines.push({ id:null, title:'Sneaky Extra', ref:'', qty:1, rate:'1' });
await el('eSave').onclick();
ok('a line cannot be added while locked', app.rows.length === before, String(app.rows.length));
ok('and it did not sneak into the records',
   !app.rows.some(r => r.drawing_title === 'Sneaky Extra'));

app.markGroup(gid, 'DRAFT');
app.openEntry(gid);
ok('reverting to draft unlocks again', app.multiLocked === false);

console.log('\n--- K. migration of pre-group rows ---');
app = reset([
  { id:'old1', code:'RSR-DWG-072026-001', doc_type:'DW', bill_date:'2026-07-01',
    client:'Old Co', drawing_title:'Legacy A', qty:1, rate:100, status:'BILLED' },
  { id:'old2', code:'RSR-DWG-072026-002', doc_type:'DW', bill_date:'2026-07-02',
    client:'Old Co', drawing_title:'Legacy B', qty:1, rate:200, status:'DRAFT' },
]);
ok('each old row became its own group', app.allGroups().length === 2,
   String(app.allGroups().length));
ok('group ids derived from the record id',
   app.rows.every(r => r.group_id === r.id), JSON.stringify(app.rows.map(r => r.group_id)));
ok('original codes preserved',
   app.rows.map(r => r.code).join(',') === 'RSR-DWG-072026-001,RSR-DWG-072026-002');
ok('each is a single-line group', app.allGroups().every(g => g.count === 1));
ok('statuses preserved',
   app.allGroups().map(g => g.status).sort().join(',') === 'BILLED,DRAFT');
ok('schema migrates server-side too',
   /update drawing_billing set group_id = id::text where group_id is null/.test(html));
ok('code is no longer unique per row',
   /drop constraint if exists drawing_billing_code_key/.test(html));

console.log('\n--- L. statement builder picks groups ---');
app = reset();
app.openEntry(null, 'DW');
batch('Seaford', '', TODAY, '1000');
app.mlines[0].title = 'Line One';
app.mlines.push({ id:null, title:'Line Two', ref:'', qty:1, rate:'' });
app.renderML();
await el('eSave').onclick();

el('sClient').value = 'Seaford';
el('sFrom').value = monthFirst(); el('sTo').value = TODAY;
el('sType').value = ''; el('sTerms').value = '30'; el('sVat').value = '0';
const cands = app.stmtCandidates();
ok('candidates are groups', cands.length === 1 && cands[0].count === 2,
   JSON.stringify(cands.map(c => c.count)));
app.buildPick();
ok('picker lists the group code', el('sPick').innerHTML.includes(DW1));
ok('picker shows the line count', /2 items/.test(el('sPick').innerHTML));
ok('picker total is the group total', el('sTotal').textContent.includes('2,000'),
   el('sTotal').textContent);

console.log('\n--- M. the printed billing shows the code once ---');
el('sNo').value = 'BILLDWG-26-001';
app.renderStatement(cands);
const doc = el('printRoot').innerHTML;
// the client's copy carries the billing number only; tracking stays in Monitoring
// Both of these assert an ABSENCE, so a stale literal does not fail -- it
// passes for the wrong reason. From 2026-09-01 they were looking for a code
// the app could no longer emit, and would have gone on passing with the
// tracking code printed in full on the client's copy.
ok('no tracking code on the client copy',
   doc.split(DW1).length - 1 === 0,
   String(doc.split(DW1).length - 1));
ok('and none on the line rows',
   !new RegExp('<span class="sub">[^<]*' + DW1).test(doc));
ok('lines still numbered 1.0 and 2.0', doc.includes('>1.0<') && doc.includes('>2.0<'));
ok('both line titles listed', /Line One/.test(doc) && /Line Two/.test(doc));
ok('total is the group total', /2,000\.00/.test(doc));

console.log('\n--- N. a group whose lines disagree ---');
// groupOf used to take every group field off list[0]. With line_no null on
// every row that head was whatever order the server happened to return, so
// the same billing could read BILLED on one sync and DRAFT on the next.
const mk = o => Object.assign({
  id:'r0', group_id:'g-mix', code:'RSR-DW-082026-009', bill_no:'BILLDWG-26-009',
  doc_type:'DW', bill_date:'2026-08-21', client:'Seaford', vessel:'MV SF Voyager',
  status:'DRAFT', billed_date:null, paid_date:null, invoice_no:null, remarks:null,
  line_no:null, created_at:'2026-08-21T05:07:40Z', qty:1, rate:10000,
  drawing_title:'Untitled', billable:true
}, o);
const billedLine = mk({ id:'aaa', status:'BILLED', billed_date:'2026-08-24',
                        created_at:'2026-08-21T05:07:41Z', drawing_title:'Propeller Detail Plan' });
const draftLine  = mk({ id:'bbb', status:'DRAFT',  billed_date:null,
                        created_at:'2026-08-21T05:07:40Z', drawing_title:'Hydrostatic Curves' });

const gA = app.groupOf([billedLine, draftLine]);
const gB = app.groupOf([draftLine, billedLine]);
const same = (a, b) => String(a == null ? '' : a) === String(b == null ? '' : b);
app.GROUP_FIELDS.forEach(k => ok('order-independent: ' + k, same(gA[k], gB[k]),
   String(gA[k]) + ' vs ' + String(gB[k])));
ok('head is the same line either way', gA.lines[0].id === gB.lines[0].id,
   gA.lines[0].id + ' vs ' + gB.lines[0].id);

ok('status is the least-advanced line', gA.status === 'DRAFT', String(gA.status));
ok('billed_date is the earliest non-null', gA.billed_date === '2026-08-24', String(gA.billed_date));
ok('mixed names status', gA.mixed.includes('status'), JSON.stringify(gA.mixed));
ok('mixed names billed_date', gA.mixed.includes('billed_date'), JSON.stringify(gA.mixed));
ok('mixed leaves agreeing fields out', !gA.mixed.includes('client') && !gA.mixed.includes('code'),
   JSON.stringify(gA.mixed));

const gClean = app.groupOf([billedLine,
  mk({ id:'ccc', status:'BILLED', billed_date:'2026-08-24', created_at:'2026-08-21T05:07:42Z' })]);
ok('a consistent group has an empty mixed array',
   Array.isArray(gClean.mixed) && gClean.mixed.length === 0, JSON.stringify(gClean.mixed));
ok('a one-line group is never mixed', app.groupOf([billedLine]).mixed.length === 0);

// least-advanced, not most: a PAID line beside a BILLED one is a billing that
// is not fully paid, and must not read as PAID
const gPaid = app.groupOf([
  mk({ id:'d1', status:'PAID',   billed_date:'2026-08-24', paid_date:'2026-08-26' }),
  mk({ id:'d2', status:'BILLED', billed_date:'2026-08-24' })]);
ok('PAID beside BILLED reads as BILLED', gPaid.status === 'BILLED', String(gPaid.status));
ok('paid_date still carried from the line that has one', gPaid.paid_date === '2026-08-26',
   String(gPaid.paid_date));

console.log('\n--- O. every line agrees after a group write ---');
app = reset();
app.openEntry(null, 'DW');
batch('Seaford', 'MV SF Voyager', TODAY, '10000');
app.mlines[0].title = 'Line One';
app.mlines.push({ id:null, title:'Line Two',   ref:'', qty:1, rate:'' });
app.mlines.push({ id:null, title:'Line Three', ref:'', qty:1, rate:'' });
app.renderML();
await el('eSave').onclick();
const sgid = app.allGroups()[0].id;
// the invariant GROUP_FIELDS has always claimed and nothing ever checked
const disagree = g => {
  const mine = app.rows.filter(r => app.groupIdOf(r) === String(g));
  if (!mine.length) return ['(no lines)'];
  return app.GROUP_FIELDS.filter(k => {
    const h = mine[0][k] == null ? '' : String(mine[0][k]);
    return mine.some(r => (r[k] == null ? '' : String(r[k])) !== h);
  });
};

app.markGroup(sgid, 'BILLED');
ok('markGroup leaves every line agreeing', disagree(sgid).length === 0, disagree(sgid).join(','));
ok('and the group reports nothing mixed', app.groupById(sgid).mixed.length === 0,
   JSON.stringify(app.groupById(sgid).mixed));
ok('group reads BILLED', app.groupById(sgid).status === 'BILLED', app.groupById(sgid).status);

app.markGroup(sgid, 'DRAFT');
const moved = await app.markBilledNow(app.allGroups());
// this suite runs offline, so n (billings the SERVER has) is 0 by design and
// the three line writes are queued -- which is exactly what should be reported
ok('markBilledNow queues the group offline, and claims nothing landed',
   moved.n === 0 && moved.queued === 3 && moved.dead === 0, JSON.stringify(moved));
ok('and the group is BILLED locally', app.groupById(sgid).status === 'BILLED',
   app.groupById(sgid).status);
ok('markBilledNow leaves every line agreeing', disagree(sgid).length === 0, disagree(sgid).join(','));
ok('and nothing mixed after it', app.groupById(sgid).mixed.length === 0,
   JSON.stringify(app.groupById(sgid).mixed));

console.log('\n--- P. a straggler left in DRAFT ---');
// exactly the shape found on the server: three lines BILLED, one still DRAFT
// because its PATCH never landed. The group has to stay markable, or the line
// is stranded for good -- which is what happened for five days.
app.rows[1].status = 'DRAFT';
app.rows[1].billed_date = null;
const split = app.groupById(sgid);
ok('a split group reads as DRAFT', split.status === 'DRAFT', String(split.status));
ok('and names the fields that differ', split.mixed.includes('status'), JSON.stringify(split.mixed));
app.render();
ok('Monitoring badges it', el('list').innerHTML.includes('Lines differ'));
ok('and the badge names the field', /Lines differ[^<]*status/.test(el('list').innerHTML));

ok('the split group is still markable',
   (await app.markBilledNow(app.allGroups())).queued > 0);
ok('marking heals it', disagree(sgid).length === 0, disagree(sgid).join(','));
ok('and clears the mixed flag', app.groupById(sgid).mixed.length === 0,
   JSON.stringify(app.groupById(sgid).mixed));
app.render();
ok('the badge is gone', !el('list').innerHTML.includes('Lines differ'));

console.log('\n--- Q. money is bucketed by line status, not group status ---');
// The exact six rows on the server on 2026-08-28, one per line, all qty 1 at
// 10,000:
//   loc-mt2hn5wi44njli (RSR-DW-082026-001)  3 BILLED, 1 DRAFT
//   loc-mt88r2ibt80wtm (RSR-DW-082026-002)  1 BILLED, 1 DRAFT
// Correct: unbilled 20,000, receivable 40,000, collected 0.
// Both groups roll up to DRAFT, so bucketing whole-group amounts by group
// status put all 60,000 in unbilled and left receivable empty.
let seq = 0;
const L = (gid, code, status, extra) => Object.assign({
  id: 'ln' + (++seq), group_id: gid, code,
  bill_no: 'BILLDWG-26-' + code.slice(-3),
  client: 'Seaford', vessel: 'MV SF CRUISER', doc_type: 'DW',
  bill_date: '2026-08-21', drawing_title: 'Line ' + seq,
  qty: 1, rate: 10000, status, billable: true, line_no: null,
  created_at: '2026-08-21T05:00:0' + seq + 'Z',
}, extra || {});

const six = [
  L('loc-mt2hn5wi44njli', 'RSR-DW-082026-001', 'BILLED'),
  L('loc-mt2hn5wi44njli', 'RSR-DW-082026-001', 'BILLED'),
  L('loc-mt2hn5wi44njli', 'RSR-DW-082026-001', 'BILLED'),
  L('loc-mt2hn5wi44njli', 'RSR-DW-082026-001', 'DRAFT'),
  L('loc-mt88r2ibt80wtm', 'RSR-DW-082026-002', 'BILLED'),
  L('loc-mt88r2ibt80wtm', 'RSR-DW-082026-002', 'DRAFT'),
];
app = reset(six);
app.render();
const txt = id => document.getElementById(id).textContent;

ok('six lines in two billings', app.rows.length === 6 && app.allGroups().length === 2,
   app.rows.length + ' rows / ' + app.allGroups().length + ' groups');
ok('unbilled counts only DRAFT lines',    txt('tDraft') === '₱20,000', txt('tDraft'));
ok('receivable counts only BILLED lines', txt('tRecv')  === '₱40,000', txt('tRecv'));
ok('collected is zero',                   txt('tPaid')  === '₱0',      txt('tPaid'));

// a split billing lands in two tiles, so it has to be counted in both --
// otherwise receivable reads 40,000 across "0 billings"
ok('both billings have unbilled work',  /2 billings/.test(txt('cDraft')), txt('cDraft'));
ok('both have receivable work',         /2 billings/.test(txt('cRecv')),  txt('cRecv'));
ok('none collected',                    /0 billings/.test(txt('cPaid')),  txt('cPaid'));

console.log('\n--- Q2. the chips reach the billed work inside a split billing ---');
const chips = document.getElementById('chips').innerHTML;
ok('the Draft chip counts 2',  /Draft<span class="n">2</.test(chips),  chips);
ok('the Billed chip counts 2', /Billed<span class="n">2</.test(chips), chips);
ok('the Paid chip counts 0',   /Paid<span class="n">0</.test(chips),   chips);

app.filters.status = 'BILLED';
app.render();
ok('the Billed chip lists the split billing',
   /RSR-DW-082026-001/.test(document.getElementById('list').innerHTML));
app.filters.status = 'DRAFT';
app.render();
ok('and so does the Draft chip',
   /RSR-DW-082026-001/.test(document.getElementById('list').innerHTML));
app.filters.status = 'ALL';
app.render();

console.log('\n--- Q3. groupOf is untouched ---');
const qg1 = app.groupById('loc-mt2hn5wi44njli');
const qg2 = app.groupById('loc-mt88r2ibt80wtm');
ok('a split group still reads least-advanced', qg1.status === 'DRAFT', qg1.status);
ok('and so does the second', qg2.status === 'DRAFT', qg2.status);
ok('the group total is still the whole billing', qg1.total === 40000, String(qg1.total));
ok('mixed still names status', qg2.mixed.includes('status'), JSON.stringify(qg2.mixed));
const shown = document.getElementById('list').innerHTML;
ok('the DRAFT badge is still drawn', /class="badge DRAFT">DRAFT</.test(shown));
ok('the Lines differ badge is still drawn', /Lines differ/.test(shown));

console.log('\n--- Q4. no-charge work is delivered, not owed ---');
app = reset(six.concat([
  L('g-free', 'RSR-DW-082026-003', 'DRAFT', { billable:false }),
]));
app.render();
ok('a no-charge line adds nothing to unbilled', txt('tDraft') === '₱20,000', txt('tDraft'));
ok('and its billing is not counted',            /2 billings/.test(txt('cDraft')), txt('cDraft'));

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
