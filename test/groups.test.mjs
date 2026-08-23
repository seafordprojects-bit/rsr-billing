import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || path.join(ROOT, 'index.html');
const FN_SRC = path.join(ROOT, 'supabase', 'functions', 'send-statement', 'index.ts');
import { net } from './harness.mjs';
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
batch('Seaford', 'MV SF Voyager', '2026-08-21', '10000');
app.mlines[0].title = 'General Arrangement Plan';
app.mlines.push({ id:null, title:'Construction Plan', ref:'', qty:1, rate:'' });
app.mlines.push({ id:null, title:'Capacity Plan',     ref:'', qty:1, rate:'' });
app.mlines.push({ id:null, title:'Shell Expansion',   ref:'', qty:1, rate:'' });
app.renderML();
await el('eSave').onclick();
ok('four line records created', app.rows.length === 4, String(app.rows.length));
const codes = new Set(app.rows.map(r => r.code));
ok('all four share one code', codes.size === 1, [...codes].join(','));
ok('the code is the next in the run', [...codes][0] === 'RSR-DW-082026-001', [...codes][0]);
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
   (el('list').innerHTML.match(/RSR-DW-082026-001/g) || []).length === 1,
   String((el('list').innerHTML.match(/RSR-DW-082026-001/g) || []).length));
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
ok('next code is 002, not 005', app.nextCode('2026-08-21','DW') === 'RSR-DW-082026-002',
   app.nextCode('2026-08-21','DW'));

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
el('kDate').value = '2026-08-21'; el('kRate').value = '2000'; el('kType').value = 'DC';
app.openCat('DC');
await el('kCommit').onclick();
ok('three lines', app.rows.length === 3, String(app.rows.length));
ok('one group', app.allGroups().length === 1, String(app.allGroups().length));
ok('one shared code', new Set(app.rows.map(r => r.code)).size === 1);
ok('code is a DC code', app.rows[0].code.startsWith('RSR-DC-'), app.rows[0].code);

console.log('\n--- H. a single quick add is a group of one ---');
app = reset();
app.openEntry(null, 'UT');
batch('Seaford', '', '2026-08-21', '5000');
app.mlines[0].title = 'UTG Report';
await el('eSave').onclick();
const g1 = app.allGroups()[0];
ok('one group of one line', app.allGroups().length === 1 && g1.count === 1);
ok('still gets a tracking code', g1.code === 'RSR-UT-082026-001', g1.code);

console.log('\n--- I. editing a DRAFT can add and remove lines ---');
app = reset();
app.openEntry(null, 'DW');
batch('Seaford', '', '2026-08-21', '1000');
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
ok('code unchanged by the edit', g2.code === 'RSR-DW-082026-001', g2.code);
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
batch('Seaford', '', '2026-08-21', '1000');
app.mlines[0].title = 'Line One';
app.mlines.push({ id:null, title:'Line Two', ref:'', qty:1, rate:'' });
app.renderML();
await el('eSave').onclick();

el('sClient').value = 'Seaford';
el('sFrom').value = '2026-08-01'; el('sTo').value = '2026-08-31';
el('sType').value = ''; el('sTerms').value = '30'; el('sVat').value = '0';
const cands = app.stmtCandidates();
ok('candidates are groups', cands.length === 1 && cands[0].count === 2,
   JSON.stringify(cands.map(c => c.count)));
app.buildPick();
ok('picker lists the group code', el('sPick').innerHTML.includes('RSR-DW-082026-001'));
ok('picker shows the line count', /2 items/.test(el('sPick').innerHTML));
ok('picker total is the group total', el('sTotal').textContent.includes('2,000'),
   el('sTotal').textContent);

console.log('\n--- M. the printed billing shows the code once ---');
el('sNo').value = 'BILLDWG-26-001';
app.renderStatement(cands);
const doc = el('printRoot').innerHTML;
// the client's copy carries the billing number only; tracking stays in Monitoring
ok('no tracking code on the client copy',
   (doc.match(/RSR-DW-082026-001/g) || []).length === 0,
   String((doc.match(/RSR-DW-082026-001/g) || []).length));
ok('and none on the line rows',
   !/<span class="sub">[^<]*RSR-DW-082026-001/.test(doc));
ok('lines still numbered 1.0 and 2.0', doc.includes('>1.0<') && doc.includes('>2.0<'));
ok('both line titles listed', /Line One/.test(doc) && /Line Two/.test(doc));
ok('total is the group total', /2,000\.00/.test(doc));

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
