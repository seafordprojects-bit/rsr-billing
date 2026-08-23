import { net } from './harness.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra='') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const el = id => document.getElementById(id);
const clearLS = () => ['rsr_dwg_cfg_v1','rsr_dwg_rows_v1','rsr_dwg_queue_v1',
                       'rsr_dwg_session_v1','rsr_dwg_catalog_v1']
  .forEach(k => globalThis.localStorage.removeItem(k));
const configure = (app) => {
  app.cfg.url = 'https://proj.supabase.co'; app.cfg.key = 'anon-key';
  globalThis.localStorage.setItem('rsr_dwg_cfg_v1', JSON.stringify(app.cfg));
};

console.log('\n--- A. catalog starts empty (nothing seeded) ---');
clearLS();
net.mode = 'offline';
let app = globalThis.__loadApp();
ok('catalog empty on a fresh install', app.catalog.length === 0, 'n=' + app.catalog.length);

console.log('\n--- B. adding items offline queues them ---');
configure(app);
app.setSession({ access_token:'t', refresh_token:'r', expires_in:3600, user:{email:'raffy@rsr.test'} });
await app.catSave({ name:'Shell Expansion Plan', drawing_no:'SE-01',
                    default_rate:null, sort_order:0, active:true }, true);
await app.catSave({ name:'Midship Section', drawing_no:'MS-01',
                    default_rate:2500, sort_order:1, active:true }, true);
await app.catSave({ name:'Docking Plan', drawing_no:'', default_rate:null,
                    sort_order:2, active:true }, true);
ok('three items cached locally', app.catalog.length === 3, 'n=' + app.catalog.length);
ok('all queued for sync', app.queue.filter(j => j.store === 'catalog').length === 3,
   'queued=' + app.queue.filter(j => j.store === 'catalog').length);
ok('catalog jobs target drawing_catalog',
   app.queue.filter(j => j.store === 'catalog').every(j => j.table === 'drawing_catalog'));

console.log('\n--- C. per-item default_rate overrides the batch rate ---');
const batch = 1500;
const rateOf = c => app.effRate(c, batch);
const byName = n => app.catalog.find(c => c.name === n);
ok('blank default falls back to batch', rateOf(byName('Shell Expansion Plan')) === 1500,
   String(rateOf(byName('Shell Expansion Plan'))));
ok('own default wins', rateOf(byName('Midship Section')) === 2500,
   String(rateOf(byName('Midship Section'))));
ok('a zero default is honoured, not treated as blank',
   app.effRate({ default_rate: 0 }, batch) === 0,
   String(app.effRate({ default_rate: 0 }, batch)));

console.log('\n--- D. deactivating hides from the picker but keeps the row ---');
const mid = byName('Midship Section');
mid.active = false;
await app.catSave(mid, false);
ok('still stored', app.catalog.length === 3, 'n=' + app.catalog.length);
ok('excluded from the picker', app.catActive().length === 2,
   'active=' + app.catActive().length);
ok('picker order follows sort_order',
   app.catActive().map(c => c.name).join(' | ') === 'Shell Expansion Plan | Docking Plan',
   app.catActive().map(c => c.name).join(' | '));
mid.active = true; await app.catSave(mid, false);

console.log('\n--- E. reorder rewrites sort_order and queues updates ---');
let list = app.catSorted();
const swapped = [list[1], list[0], list[2]];
await app.catReorder(swapped);
ok('new first item', app.catSorted()[0].name === 'Midship Section',
   app.catSorted()[0].name);
ok('sort_order renumbered 0..n',
   app.catSorted().map(c => c.sort_order).join(',') === '0,1,2',
   app.catSorted().map(c => c.sort_order).join(','));

console.log('\n--- F. catalog survives a reload ---');
const before = app.catalog.length;
app = globalThis.__loadApp();
ok('catalog restored from cache', app.catalog.length === before,
   'n=' + app.catalog.length + ' expected ' + before);
ok('works offline with no session', app.catActive().length === 3,
   'active=' + app.catActive().length);

console.log('\n--- G. building drafts from the catalog ---');
clearLS();
net.mode = 'offline';
app = globalThis.__loadApp();
configure(app);
await app.catSave({ name:'Shell Expansion Plan', drawing_no:'SE-01', default_rate:null, sort_order:0, active:true }, true);
await app.catSave({ name:'Midship Section',      drawing_no:'MS-01', default_rate:2500, sort_order:1, active:true }, true);
await app.catSave({ name:'Docking Plan',         drawing_no:'',      default_rate:null, sort_order:2, active:true }, true);

el('kClient').value = 'Seaford Shipping Lines';
el('kVessel').value = 'MV SF Voyager';
el('kDate').value   = '2026-08-21';
el('kRate').value   = '1500';
app.openCat();
ok('all items ticked by default', el('kCommit').textContent === 'Add 3 documents',
   el('kCommit').textContent);
ok('live total uses per-item overrides', el('kTotal').textContent.includes('5,500'),
   el('kTotal').textContent);   // 1500 + 2500 + 1500

const rowsBefore = app.rows.length;
await el('kCommit').onclick();
const made = app.rows.slice(0, app.rows.length - rowsBefore);
ok('one DRAFT per ticked item', made.length === 3, 'made=' + made.length);
ok('all DRAFT', made.every(r => r.status === 'DRAFT'));
ok('client and vessel applied', made.every(r =>
   r.client === 'Seaford Shipping Lines' && r.vessel === 'MV SF Voyager'));
ok('drawing_no carried over', made.some(r => r.drawing_no === 'SE-01'));
ok('rates resolved per item',
   made.map(r => r.rate).sort((a,b)=>a-b).join(',') === '1500,1500,2500',
   made.map(r => r.rate).join(','));

const codes = made.map(r => r.code).sort();
ok('the batch is one billing sharing one code', new Set(codes).size === 1, codes.join(' '));
ok('codes use the month stamp', codes.every(c => c.startsWith('RSR-DW-082026-')),
   codes.join(' '));
ok('that code is the next in the run', codes[0] === 'RSR-DW-082026-001', codes[0]);
ok('all three lines are in one group',
   new Set(made.map(app.groupIdOf)).size === 1, codes.join(','));
ok('drafts queued for sync while offline',
   app.queue.filter(j => !j.store).length === 3,
   'q=' + app.queue.filter(j => !j.store).length);

console.log('\n--- H. unticking limits what is created ---');
app.kPicked[app.catActive()[0].id] = false;
app.renderCat();
ok('commit label follows the ticks', el('kCommit').textContent === 'Add 2 documents',
   el('kCommit').textContent);

console.log('\n--- I. back online: catalog and drafts both drain ---');
net.mode = 'online';
await app.flushQueue();
ok('queue emptied', app.queue.length === 0, 'q=' + app.queue.length);
ok('catalog rows got server ids',
   app.catalog.every(c => !String(c.id).startsWith('loc-')),
   JSON.stringify(app.catalog.map(c => c.id)));
ok('billing rows got server ids',
   app.rows.every(r => !String(r.id).startsWith('loc-')));

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
