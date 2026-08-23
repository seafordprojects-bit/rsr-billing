import { net } from './harness.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra='') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const el = id => document.getElementById(id);
const KEYS = ['rsr_dwg_cfg_v1','rsr_dwg_rows_v1','rsr_dwg_queue_v1','rsr_dwg_session_v1','rsr_dwg_catalog_v1'];
const clearLS = () => KEYS.forEach(k => globalThis.localStorage.removeItem(k));
const seedCfg = (o) => globalThis.localStorage.setItem('rsr_dwg_cfg_v1', JSON.stringify(o));

console.log('\n--- A. seeded types and the root migration ---');
clearLS();
net.mode = 'offline';
let app = globalThis.__loadApp();
ok('seeded with UT, DW and DC',
   app.typeList().map(t => t.code).join(',') === 'UT,DW,DC',
   app.typeList().map(t => t.code).join(','));
ok('labels seeded',
   app.typeLabel('DW') === 'Drawing' && app.typeLabel('DC') === 'Drydocking Certificate',
   app.typeLabel('DW') + ' / ' + app.typeLabel('DC'));
ok('legacy RSR-DWG prefix migrates to root RSR', app.cfg.root === 'RSR', app.cfg.root);

clearLS(); seedCfg({ prefix:'ACME-DWG' });
let a2 = globalThis.__loadApp();
ok('a custom legacy prefix keeps its own root', a2.cfg.root === 'ACME', a2.cfg.root);
clearLS(); seedCfg({ prefix:'ACME' });
a2 = globalThis.__loadApp();
ok('a prefix with no -DWG is used as-is', a2.cfg.root === 'ACME', a2.cfg.root);

console.log('\n--- B. code shape and independent per-type sequences ---');
clearLS();
app = globalThis.__loadApp();
ok('code shape is root-type-MMYYYY-###',
   app.nextCode('2026-08-21','DW') === 'RSR-DW-082026-001',
   app.nextCode('2026-08-21','DW'));
ok('a different type has its own run',
   app.nextCode('2026-08-21','DC') === 'RSR-DC-082026-001',
   app.nextCode('2026-08-21','DC'));

const mk = (code, type) => ({ id:'x'+code, code, doc_type:type, bill_date:'2026-08-21',
  client:'C', drawing_title:'T', qty:1, rate:1, status:'DRAFT' });
app.rows.push(mk('RSR-DW-082026-001','DW'), mk('RSR-DW-082026-002','DW'),
              mk('RSR-DC-082026-001','DC'));
ok('DW continues past its own rows',
   app.nextCode('2026-08-21','DW') === 'RSR-DW-082026-003',
   app.nextCode('2026-08-21','DW'));
ok('DC is unaffected by the DW run',
   app.nextCode('2026-08-21','DC') === 'RSR-DC-082026-002',
   app.nextCode('2026-08-21','DC'));
ok('a new month restarts at 001',
   app.nextCode('2026-09-01','DW') === 'RSR-DW-092026-001',
   app.nextCode('2026-09-01','DW'));

console.log('\n--- C. legacy RSR-DWG-* codes are left alone but keep the run going ---');
clearLS();
app = globalThis.__loadApp();
app.rows.push(mk('RSR-DWG-082026-001', undefined), mk('RSR-DWG-082026-007', undefined));
ok('an untyped legacy row reads as DW', app.typeOf(app.rows[0]) === 'DW', app.typeOf(app.rows[0]));
ok('DW continues on from the legacy run instead of restarting',
   app.nextCode('2026-08-21','DW') === 'RSR-DW-082026-008',
   app.nextCode('2026-08-21','DW'));
ok('legacy codes themselves are untouched',
   app.rows.map(r => r.code).join(',') === 'RSR-DWG-082026-001,RSR-DWG-082026-007',
   app.rows.map(r => r.code).join(','));
ok('a non-default type ignores the legacy run',
   app.nextCode('2026-08-21','DC') === 'RSR-DC-082026-001',
   app.nextCode('2026-08-21','DC'));
ok('DWG is not double counted as a DW prefix match',
   app.nextCode('2026-08-21','DW') !== 'RSR-DW-082026-009');

console.log('\n--- D. a mixed catalog batch keeps each type on its own run ---');
clearLS();
app = globalThis.__loadApp();
app.cfg.url='https://p.supabase.co'; app.cfg.key='k';
globalThis.localStorage.setItem('rsr_dwg_cfg_v1', JSON.stringify(app.cfg));
await app.catSave({ name:'Shell Expansion', doc_type:'DW', drawing_no:'SE-1', default_rate:null, sort_order:0, active:true }, true);
await app.catSave({ name:'Midship Section', doc_type:'DW', drawing_no:'MS-1', default_rate:null, sort_order:1, active:true }, true);
await app.catSave({ name:'Drydock Cert A',  doc_type:'DC', drawing_no:'',     default_rate:3000, sort_order:2, active:true }, true);

el('kClient').value='Seaford'; el('kVessel').value='MV SF Voyager';
el('kDate').value='2026-08-21'; el('kRate').value='1500'; el('kType').value='';
app.openCat();
ok('picker shows every type by default', app.catShown().length === 3,
   'shown=' + app.catShown().length);

await el('kCommit').onclick();
const made = app.rows.filter(r => String(r.id).startsWith('loc-'));
const codes = made.map(r => r.code).sort();
// the two DW items are now one billing sharing one code
ok('both DW items share one DW code',
   new Set(codes.filter(c => c.startsWith('RSR-DW-'))).size === 1 &&
   codes.filter(c => c.startsWith('RSR-DW-')).length === 2,
   codes.join(' '));
ok('the DC item becomes its own billing on its own run',
   codes.filter(c => c.startsWith('RSR-DC-')).join(',') === 'RSR-DC-082026-001',
   codes.join(' '));
ok('a mixed pick makes one billing per type',
   new Set(made.map(app.groupIdOf)).size === 2,
   String(new Set(made.map(app.groupIdOf)).size));
ok('doc_type carried onto each record',
   made.filter(r => r.doc_type === 'DW').length === 2 &&
   made.filter(r => r.doc_type === 'DC').length === 1,
   made.map(r => r.doc_type).join(','));
ok('per-item default rate still wins',
   made.find(r => r.doc_type === 'DC').rate === 3000,
   String(made.find(r => r.doc_type === 'DC').rate));

console.log('\n--- E. catalog type filter narrows the picker ---');
el('kType').value = 'DC';
app.renderCat();
ok('only DC items shown', app.catShown().length === 1, 'shown=' + app.catShown().length);
ok('commit label follows the filter', el('kCommit').textContent === 'Add 1 document',
   el('kCommit').textContent);
el('kType').value = '';

console.log('\n--- F. main list type filter ---');
app.filters = { q:'', status:'ALL', client:'', month:'', type:'DC' };
ok('list filtered to DC', app.visible().every(r => app.typeOf(r) === 'DC') &&
   app.visible().length === 1, 'n=' + app.visible().length);
app.filters = { q:'', status:'ALL', client:'', month:'', type:'DW' };
// visible() lists billings now, so the two DW lines are one entry
ok('list filtered to DW', app.visible().length === 1, 'n=' + app.visible().length);
app.filters = { q:'', status:'ALL', client:'', month:'', type:'' };
ok('no filter shows all billings', app.visible().length === 2, 'n=' + app.visible().length);

console.log('\n--- G. statement builder filters by type ---');
el('sClient').innerHTML = ''; el('sClient').value = 'Seaford';
el('sFrom').value = '2026-08-01'; el('sTo').value = '2026-08-31';
el('sType').value = '';
ok('all types offered', app.stmtCandidates().length === 2,
   'n=' + app.stmtCandidates().length);
el('sType').value = 'DC';
ok('narrowed to DC', app.stmtCandidates().length === 1 &&
   app.typeOf(app.stmtCandidates()[0]) === 'DC', 'n=' + app.stmtCandidates().length);
app.buildPick();
ok('picker line shows the type code', el('sPick').innerHTML.includes('DC ·'),
   el('sPick').innerHTML.slice(0, 160));

console.log('\n--- H. payloads carry doc_type to Supabase ---');
net.mode = 'online';
net.calls.length = 0;
await app.flushQueue();
const posted = net.calls.filter(c => c.method === 'POST');
ok('inserts were posted', posted.length > 0, 'n=' + posted.length);
ok('billing payloads include doc_type',
   app.rows.every(r => r.doc_type === 'DW' || r.doc_type === 'DC'));
ok('catalog payloads include doc_type',
   app.catalog.every(c => c.doc_type === 'DW' || c.doc_type === 'DC'),
   app.catalog.map(c => c.doc_type).join(','));

console.log('\n--- I. removing a type leaves existing records readable ---');
app.cfg.types = [{ code:'DW', label:'Drawing' }];
ok('a record keeps its removed type code',
   app.typeOf({ doc_type:'DC' }) === 'DC');
ok('a built-in keeps its known label even when removed from Settings',
   app.typeLabel('DC') === 'Drydocking Certificate', app.typeLabel('DC'));
ok('a custom code falls back to the bare code', app.typeLabel('ZZ') === 'ZZ', app.typeLabel('ZZ'));

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
