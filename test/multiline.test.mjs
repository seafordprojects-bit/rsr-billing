import { net } from './harness.mjs';
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (name, cond, extra='') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const el = id => document.getElementById(id);
const KEYS = ['rsr_dwg_cfg_v1','rsr_dwg_rows_v1','rsr_dwg_queue_v1','rsr_dwg_session_v1',
              'rsr_dwg_catalog_v1','rsr_dwg_clients_v1'];
const reset = () => { KEYS.forEach(k => globalThis.localStorage.removeItem(k));
                      return globalThis.__loadApp(); };

net.mode = 'offline';
let app = reset();

const line = (i, f, v) => { app.mlines[i][f] = v; };
const batch = (client, vessel, date, rate) => {
  el('eClient').value = client; el('eVessel').value = vessel;
  el('eDate').value = date;     el('eRate').value = rate;
};

console.log('\n--- A. multi mode only where the type is fixed ---');
app.openEntry(null, 'DW');
ok('Create Billing opens in multi mode', el('multiWrap').hidden === false);
ok('per-item fields move out of the top', el('wTitle').hidden === true &&
   el('wRefQty').hidden === true);
ok('the code field shows the billing code', el('wCode').hidden === false);
ok('status block hidden (everything is a DRAFT)', el('wStatus').hidden === true);
ok('rate relabelled as the batch default',
   el('eRateLbl').textContent === 'Default rate per line (₱)', el('eRateLbl').textContent);
ok('starts with one empty line', app.mlines.length === 1);

app.openEntry(null);
ok('a Monitoring quick add is still a billing of lines',
   el('multiWrap').hidden === false && el('wTitle').hidden === true);
app.rows.push({ id:'rr', code:'RSR-DW-082026-090', doc_type:'DW', bill_date:'2026-08-21',
                client:'C', drawing_title:'T', qty:1, rate:1, status:'DRAFT' });
app.openEntry(app.allGroups()[0].id);
ok('editing a billing uses the same line list', el('multiWrap').hidden === false);

console.log('\n--- B. one filled line behaves like the old single add ---');
app = reset();
app.openEntry(null, 'DW');
batch('Seaford', 'MV SF Voyager', '2026-08-21', '1500');
line(0, 'title', 'Shell Expansion Plan');
line(0, 'ref', 'SE-01');
await el('eSave').onclick();
ok('one record created', app.rows.length === 1, String(app.rows.length));
const one = app.rows[0];
ok('title carried', one.drawing_title === 'Shell Expansion Plan');
ok('ref carried', one.drawing_no === 'SE-01');
ok('qty defaults to 1', one.qty === 1, String(one.qty));
ok('rate inherited from the batch', one.rate === 1500, String(one.rate));
ok('client and vessel from the batch fields',
   one.client === 'Seaford' && one.vessel === 'MV SF Voyager');
ok('created as DRAFT', one.status === 'DRAFT');
ok('type from the tab', one.doc_type === 'DW');
ok('code sequenced', one.code === 'RSR-DW-082026-001', one.code);

console.log('\n--- C. several lines, one record each ---');
app = reset();
app.openEntry(null, 'DC');
batch('Seaford', 'MV SF Voyager', '2026-08-21', '2000');
line(0, 'title', 'Docking Plan');
app.mlines.push({ title:'Hull Survey Cert', ref:'HS-1', qty:2, rate:'' });
app.mlines.push({ title:'Tailshaft Cert',   ref:'',     qty:1, rate:5000 });
app.renderML();
ok('live total uses per-line overrides and the batch default',
   el('mlTotal').textContent.includes('11,000'), el('mlTotal').textContent);
   // 2000 + (2 x 2000) + 5000
ok('save button counts the filled lines',
   el('eSave').textContent === 'Add 3 lines', el('eSave').textContent);

await el('eSave').onclick();
ok('one record per line', app.rows.length === 3, String(app.rows.length));
const codes = app.rows.map(r => r.code).sort();
ok('the three lines share one DC code',
   new Set(codes).size === 1 && codes[0] === 'RSR-DC-082026-001', codes.join(',')); 
ok('qty respected per line', app.rows.some(r => r.qty === 2));
ok('per-line rate overrides the batch', app.rows.some(r => r.rate === 5000));
ok('unset rates fall back to the batch',
   app.rows.filter(r => r.rate === 2000).length === 2,
   app.rows.map(r => r.rate).join(','));
ok('all DRAFT', app.rows.every(r => r.status === 'DRAFT'));
ok('queued through the same saveBatch path',
   app.queue.filter(j => j.op === 'insert' && !j.store).length === 3,
   JSON.stringify(app.queue.map(j => j.store || 'rows')));

console.log('\n--- D. empty lines are ignored, a title is required ---');
app = reset();
app.openEntry(null, 'DW');
batch('Seaford', '', '2026-08-21', '1500');
app.mlines.push(mlEmpty()); app.mlines.push(mlEmpty());
function mlEmpty(){ return { title:'', ref:'', qty:1, rate:'' }; }
line(0, 'title', 'Only Real Line');
app.renderML();
await el('eSave').onclick();
ok('blank lines skipped', app.rows.length === 1, String(app.rows.length));

app = reset();
app.openEntry(null, 'DW');
batch('Seaford', '', '2026-08-21', '1500');
await el('eSave').onclick();
ok('nothing created with no titled line', app.rows.length === 0, String(app.rows.length));

app = reset();
app.openEntry(null, 'DW');
batch('', '', '2026-08-21', '1500');
line(0, 'title', 'X');
await el('eSave').onclick();
ok('client is still required', app.rows.length === 0, String(app.rows.length));

console.log('\n--- E. rows are removable ---');
app = reset();
app.openEntry(null, 'DW');
app.mlines.push({ title:'B', ref:'', qty:1, rate:'' });
app.renderML();
ok('remove button rendered per row', /data-mlrm="1"/.test(el('mlList').innerHTML));
ok('the last remaining row cannot be removed',
   /data-mlrm="0"[^>]*disabled/.test(el('mlList').innerHTML) === false ||
   app.mlines.length > 1);
app.mlines.splice(1, 1); app.renderML();
ok('sole row is protected from removal',
   /data-mlrm="0"[^>]*disabled/.test(el('mlList').innerHTML),
   el('mlList').innerHTML.slice(0, 200));

console.log('\n--- F. promoting typed lines into the catalog ---');
app = reset();
app.openEntry(null, 'UT');
batch('Seaford', 'MV SF Voyager', '2026-08-21', '1200');
line(0, 'title', 'UTG Hull Survey');
app.mlines.push({ title:'UTG Tank Top', ref:'UT-2', qty:1, rate:1800 });
app.renderML();
el('mlToCat').checked = true;
await el('eSave').onclick();
ok('records still created', app.rows.length === 2, String(app.rows.length));
ok('both lines became catalog items', app.catalog.length === 2, String(app.catalog.length));
ok('catalog items carry the tab type',
   app.catalog.every(c => c.doc_type === 'UT'), app.catalog.map(c => c.doc_type).join(','));
ok('an explicit line rate becomes the catalog default',
   app.catalog.find(c => c.name === 'UTG Tank Top').default_rate === 1800);
ok('a line on the batch rate stores no default',
   app.catalog.find(c => c.name === 'UTG Hull Survey').default_rate === null,
   String(app.catalog.find(c => c.name === 'UTG Hull Survey').default_rate));
ok('ref carried into the catalog',
   app.catalog.find(c => c.name === 'UTG Tank Top').drawing_no === 'UT-2');

console.log('\n--- G. promoting twice does not duplicate ---');
app.openEntry(null, 'UT');
batch('Seaford', '', '2026-08-21', '1200');
line(0, 'title', 'UTG Hull Survey');       // same name, same type
el('mlToCat').checked = true;
await el('eSave').onclick();
ok('no duplicate catalog entry', app.catalog.length === 2, String(app.catalog.length));

app.openEntry(null, 'DW');
batch('Seaford', '', '2026-08-21', '1200');
line(0, 'title', 'UTG Hull Survey');       // same name, different type
el('mlToCat').checked = true;
await el('eSave').onclick();
ok('same name under another type is a separate item',
   app.catalog.length === 3, String(app.catalog.length));

console.log('\n--- H. unchecked means nothing is promoted ---');
app = reset();
app.openEntry(null, 'DW');
batch('Seaford', '', '2026-08-21', '1500');
line(0, 'title', 'Not For Catalog');
el('mlToCat').checked = false;
await el('eSave').onclick();
ok('catalog untouched', app.catalog.length === 0, String(app.catalog.length));
ok('but the record was created', app.rows.length === 1);

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
