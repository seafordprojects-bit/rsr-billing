globalThis.__seedOK = true;          // this suite is the one that wants seeding
const { net } = await import('./harness.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, extra='') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const KEYS = ['rsr_dwg_cfg_v1','rsr_dwg_rows_v1','rsr_dwg_queue_v1','rsr_dwg_session_v1',
              'rsr_dwg_catalog_v1','rsr_dwg_clients_v1'];
const wipe = () => KEYS.forEach(k => globalThis.localStorage.removeItem(k));
const settle = () => new Promise(r => setTimeout(r, 30));

const MARINA = [
  'General Arrangement Plan',
  'Construction Plan',
  'Midship Plan and BHD Plan Details',
  'Lines Plan and Table of Offsets',
  'Hydrostatic Curves or Hydrostatic Table',
  'Shell Expansion Plan',
  'Scantling Calculation with Longitudinal Hull Girder Strength Calculation',
  'Capacity Plan',
  'Welding Schedule and Specifications',
  'Shafting and Propeller Arrangement & Specifications',
  'Specifications & Arrangement of Main Propulsion & Auxiliary Machineries',
  'Cross Curves of Stability',
  'Life Saving & Fire Control Plan',
  'Passenger Accommodation Plan',
  'Floodable Length Calculations',
  'Floodable Length Curves',
  'Damage Stability Booklet',
  'Emergency Escape Plan',
];

console.log('\n--- A. a fresh install gets the MARINA list ---');
wipe();
net.mode = 'offline';
let app = globalThis.__loadApp();
await settle();
const dw = app.catalog.filter(c => app.typeOf(c) === 'DW');
ok('all 18 plans seeded', dw.length === MARINA.length,
   dw.length + ' of ' + MARINA.length);
ok('exact names, in the given order',
   dw.map(c => c.name).join('|') === MARINA.join('|'),
   dw.map(c => c.name).slice(0, 3).join(' | '));
ok('sort_order follows the list', dw.every((c, i) => c.sort_order === i),
   dw.map(c => c.sort_order).join(','));
ok('all typed DW', dw.every(c => c.doc_type === 'DW'));
ok('all active', dw.every(c => c.active === true));
ok('no rate assumed', dw.every(c => c.default_rate === null));
ok('nothing seeded for UT or DC',
   app.catalog.filter(c => app.typeOf(c) !== 'DW').length === 0);
ok('queued for sync like any other catalog write',
   app.queue.filter(j => j.store === 'catalog').length === MARINA.length,
   String(app.queue.filter(j => j.store === 'catalog').length));

console.log('\n--- B. it does not run twice ---');
const n1 = app.catalog.length;
app = globalThis.__loadApp();            // same storage, second boot
await settle();
ok('a second boot adds nothing', app.catalog.length === n1,
   app.catalog.length + ' vs ' + n1);
ok('no duplicate names',
   new Set(app.catalog.map(c => c.name)).size === app.catalog.length);

console.log('\n--- C. it never overwrites an existing catalog ---');
wipe();
app = globalThis.__loadApp();
await settle();
app.catalog.length = 0;
await app.catSave({ name:'My Own Plan', doc_type:'DW', drawing_no:'', default_rate:5000,
                    sort_order:0, active:true }, true);
app.cfg.seededDW = false;                 // pretend the flag was never set
const seeded = await app.maybeSeedCatalog();
ok('seeding declines when DW items already exist', seeded === 0, String(seeded));
ok('the existing item is untouched',
   app.catalog.length === 1 && app.catalog[0].name === 'My Own Plan',
   JSON.stringify(app.catalog.map(c => c.name)));
ok('and the flag is set so it stops asking', app.cfg.seededDW === true);

console.log('\n--- D. clearing the catalog later does not resurrect it ---');
app.catalog.length = 0;
const again = await app.maybeSeedCatalog();
ok('an emptied catalog stays empty', again === 0 && app.catalog.length === 0,
   String(app.catalog.length));

console.log('\n--- E. online, seeding waits for a successful pull ---');
wipe();
net.mode = 'offline';                     // configured but unreachable
globalThis.localStorage.setItem('rsr_dwg_cfg_v1', JSON.stringify({
  url:'https://proj.supabase.co', key:'anon-key' }));
globalThis.localStorage.setItem('rsr_dwg_session_v1', JSON.stringify({
  access_token:'t', refresh_token:'r', expires_at: Date.now() + 3600e3, email:'r@rsr.test' }));
app = globalThis.__loadApp();
await settle();
ok('a failed pull does not seed a possibly-stale empty cache',
   app.catalog.length === 0, String(app.catalog.length));
ok('and the flag stays unset so it can seed later',
   !app.cfg.seededDW, String(app.cfg.seededDW));

console.log('\n--- F. the list matches the brief exactly ---');
ok('18 plans defined', app.MARINA_DW.length === 18, String(app.MARINA_DW.length));
ok('order preserved verbatim', app.MARINA_DW.join('|') === MARINA.join('|'));

console.log('\n--- G. a fresh device asks the server before seeding ---');
wipe();
net.mode = 'online';
net.script.length = 0;
globalThis.localStorage.setItem('rsr_dwg_cfg_v1', JSON.stringify({
  url:'https://proj.supabase.co', key:'anon-key' }));
app = globalThis.__loadApp();          // online() is true but there is no session, so
await settle();                        // boot() shows the gate and never seeds on its own
ok('boot did not seed on its own', app.catalog.length === 0, String(app.catalog.length));
net.script.push({ match:'doc_type=eq.DW', method:'GET', status:200, body:[{ id:'srv-1' }] });
const seededElsewhere = await app.maybeSeedCatalog();
ok('declines when the server already has DW items', seededElsewhere === 0,
   String(seededElsewhere));
ok('nothing queued', app.queue.filter(j => j.store === 'catalog').length === 0,
   String(app.queue.filter(j => j.store === 'catalog').length));
ok('the flag is set so it stops asking', app.cfg.seededDW === true);

console.log('\n--- H. two devices racing the seed do not double it ---');
// One shared closure cannot model this: catSave's local catalog.push happens
// synchronously, before the first await, so a second call on the SAME
// closure already sees the first call's item and bails out on the ordinary
// "already exists" guard -- no race ever occurs. Two real devices do not
// share that in-memory array, only the server, so this needs two separate
// app closures reading and writing the same simulated backend.
wipe();
net.mode = 'online';
net.script.length = 0;
net.catalogUnique = new Map();         // simulate the real unique constraint
globalThis.localStorage.setItem('rsr_dwg_cfg_v1', JSON.stringify({
  url:'https://proj.supabase.co', key:'anon-key' }));
let appA = globalThis.__loadApp();     // device A: no session, boot() bails at the gate
let appB = globalThis.__loadApp();     // device B: separate closure, same starting point
await settle();
ok('both devices start from an empty local catalog',
   appA.catalog.length === 0 && appB.catalog.length === 0,
   appA.catalog.length + ',' + appB.catalog.length);
await Promise.all([appA.maybeSeedCatalog(), appB.maybeSeedCatalog()]);
ok('the server ends up with exactly 18 rows, not 36',
   net.catalogUnique.size === MARINA.length, String(net.catalogUnique.size));
ok('no duplicate names reached the server',
   new Set([...net.catalogUnique.keys()].map(k => k.split('|')[0])).size === MARINA.length,
   [...net.catalogUnique.keys()].join('|'));
ok('nothing landed in either device\'s dead-jobs queue',
   appA.deadJobs().length === 0 && appB.deadJobs().length === 0,
   appA.deadJobs().length + ',' + appB.deadJobs().length);
ok('both queues drained completely',
   appA.queue.length === 0 && appB.queue.length === 0,
   appA.queue.length + ',' + appB.queue.length);
ok('together the two local caches account for all 18, no more',
   appA.catalog.length + appB.catalog.length === MARINA.length,
   appA.catalog.length + '+' + appB.catalog.length);

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
