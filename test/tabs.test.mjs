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
const KEYS = ['rsr_dwg_cfg_v1','rsr_dwg_rows_v1','rsr_dwg_queue_v1','rsr_dwg_session_v1',
              'rsr_dwg_catalog_v1','rsr_dwg_clients_v1'];
const clearLS = () => KEYS.forEach(k => globalThis.localStorage.removeItem(k));
const html = fs.readFileSync(SRC, 'utf8');

console.log('\n--- A. types: UT / DW / DC ---');
clearLS();
net.mode = 'offline';
let app = globalThis.__loadApp();
ok('three built-in types in tab order',
   app.TAB_TYPES.join(',') === 'UT,DW,DC', app.TAB_TYPES.join(','));
ok('UT seeded for a fresh install',
   app.typeList().some(t => t.code === 'UT'), app.typeList().map(t=>t.code).join(','));
ok('cfg order matches the tabs',
   app.cfg.types.slice(0,3).map(t=>t.code).join(',') === 'UT,DW,DC',
   app.cfg.types.map(t=>t.code).join(','));

console.log('\n--- B. an existing install gains UT and ref labels ---');
clearLS();
globalThis.localStorage.setItem('rsr_dwg_cfg_v1', JSON.stringify({
  prefix:'RSR-DWG', types:[{code:'DW',label:'Drawing'},{code:'DC',label:'Drydocking Certificate'}]
}));
let a2 = globalThis.__loadApp();
ok('UT added on upgrade', a2.typeList().some(t => t.code === 'UT'),
   a2.typeList().map(t=>t.code).join(','));
ok('existing labels kept', a2.typeLabel('DC') === 'Drydocking Certificate');
ok('ref labels backfilled', a2.refLabel('DW') === 'Drawing no.', a2.refLabel('DW'));
ok('root still migrated', a2.cfg.root === 'RSR', a2.cfg.root);

console.log('\n--- C. per-type reference labels ---');
ok('UT -> Report no.',      app.refLabel('UT') === 'Report no.',      app.refLabel('UT'));
ok('DW -> Drawing no.',     app.refLabel('DW') === 'Drawing no.',     app.refLabel('DW'));
ok('DC -> Certificate no.', app.refLabel('DC') === 'Certificate no.', app.refLabel('DC'));
ok('an unknown type falls back', app.refLabel('ZZ') === 'Ref no.', app.refLabel('ZZ'));
ok('title label is generic', /<label for="eTitle">Title<\/label>/.test(html));

console.log('\n--- D. top-level tabs ---');
app.setTab('mon');
ok('Monitoring shows the list', el('viewMon').hidden === false && el('viewNew').hidden === true);
ok('totals belong to Monitoring', el('totals').hidden === false);
ok('statement button shown', el('fabMon').hidden === false);
app.setTab('new');
ok('Create Billing swaps the view', el('viewMon').hidden === true && el('viewNew').hidden === false);
ok('totals hidden there', el('totals').hidden === true);
ok('statement button hidden there', el('fabMon').hidden === true);

console.log('\n--- E. sub-tabs fix the type ---');
app.setMakeType('UT');
ok('UTG selected', app.makeType === 'UT');
ok('no PDF drop for UTG', el('mkDrop').hidden === true);
ok('code preview uses UT', el('mkCode').textContent.startsWith('RSR-UT-'),
   el('mkCode').textContent);
app.setMakeType('DC');
ok('DC selected', app.makeType === 'DC');
ok('no PDF drop for DC', el('mkDrop').hidden === true);
ok('code preview uses DC', el('mkCode').textContent.startsWith('RSR-DC-'),
   el('mkCode').textContent);
app.setMakeType('DW');
ok('PDF drop only on Drawing', el('mkDrop').hidden === false);
ok('code preview uses DW', el('mkCode').textContent.startsWith('RSR-DW-'),
   el('mkCode').textContent);
app.setMakeType('ZZ');
ok('an unknown sub-tab falls back to DW', app.makeType === 'DW');

console.log('\n--- F. manual entry inherits the sub-tab type and locks it ---');
app.openEntry(null, 'DC');
ok('type preset to DC', el('eType').value === 'DC', el('eType').value);
ok('selector locked', el('eType').disabled === true);
ok('lock explained', el('eTypeHint').hidden === false);
ok('ref label follows the type', el('eRefLbl').textContent === 'Certificate no.',
   el('eRefLbl').textContent);
ok('code preset for DC', el('eCode').value.startsWith('RSR-DC-'), el('eCode').value);

app.openEntry(null, 'UT');
ok('UT preset', el('eType').value === 'UT' && el('eRefLbl').textContent === 'Report no.',
   el('eType').value + '/' + el('eRefLbl').textContent);

app.rows.push({ id:'r1', code:'RSR-DW-082026-001', doc_type:'DW', bill_date:'2026-08-21',
                client:'C', drawing_title:'T', qty:1, rate:1, status:'DRAFT' });
app.openEntry(app.groupIdOf(app.rows[0]));
ok('the type is fixed once a billing has a code', el('eType').disabled === true);
ok('and the reason is shown', el('eTypeHint').hidden === false);

console.log('\n--- G. catalog picker is scoped to its sub-tab ---');
clearLS();
app = globalThis.__loadApp();
app.cfg.url='https://p.supabase.co'; app.cfg.key='k';
await app.catSave({ name:'Shell Expansion', doc_type:'DW', drawing_no:'SE-1', default_rate:null, sort_order:0, active:true }, true);
await app.catSave({ name:'UTG hull survey', doc_type:'UT', drawing_no:'UT-1', default_rate:null, sort_order:1, active:true }, true);
await app.catSave({ name:'Drydock cert',    doc_type:'DC', drawing_no:'',     default_rate:null, sort_order:2, active:true }, true);

app.openCat('UT');
ok('only UT items offered', app.catShown().length === 1 &&
   app.catShown()[0].name === 'UTG hull survey', String(app.catShown().length));
ok('type selector hidden when locked', el('kTypeWrap').hidden === true);
ok('sheet titled for the type', el('catTitle').textContent.includes('UTG report'),
   el('catTitle').textContent);

app.openCat('DW');
ok('switching sub-tab re-scopes', app.catShown().length === 1 &&
   app.catShown()[0].name === 'Shell Expansion', String(app.catShown().length));

app.openCat();
ok('opened unscoped, the selector returns', el('kTypeWrap').hidden === false);
ok('all types offered unscoped', app.catShown().length === 3, String(app.catShown().length));

console.log('\n--- H. PDF import is pinned to Drawing ---');
app.openImport(false);
ok('import type forced to DW', el('iType').value === 'DW', el('iType').value);
ok('import type selector hidden', /id="iTypeWrap" hidden/.test(html));

console.log('\n--- H2. hidden actually hides (CSS specificity) ---');
// `hidden` is only honoured via the UA rule [hidden]{display:none}; any author
// display rule outranks it. These three elements all set one and are toggled
// with .hidden, so without an explicit override they never actually hide.
ok('a global [hidden] override exists', /\[hidden\]\{display:none ?!important\}/.test(html));
const authorDisplay = (sel) => {
  const m = html.match(new RegExp('\\' + sel + '\\{[^}]*\\}'));
  return m ? /display:/.test(m[0]) : false;
};
ok('.drop sets its own display (needs the override)', authorDisplay('.drop'));
ok('.chk sets its own display (needs the override)', authorDisplay('.chk'));
ok('.imp-status sets its own display (needs the override)', authorDisplay('.imp-status'));

console.log('\n--- H3. type names keep their capitals ---');
const utg = app.builtIn('UT'), dw = app.builtIn('DW'), dc = app.builtIn('DC');
ok('UTG stays uppercase mid-sentence', 'One ' + utg.one === 'One UTG report', 'One ' + utg.one);
ok('drawing reads naturally', 'One ' + dw.one === 'One drawing', 'One ' + dw.one);
ok('drydocking certificate reads naturally',
   'One ' + dc.one === 'One drydocking certificate', 'One ' + dc.one);
ok('plurals keep capitals too', utg.many === 'UTG reports', utg.many);
ok('no title is lowercased for display', !/b\.title\.toLowerCase\(\)/.test(html));

app.setMakeType('UT');
ok('UTG manual label rendered correctly',
   el('mkOneSub').textContent === 'One UTG report, filled in by hand.',
   el('mkOneSub').textContent);
ok('still no drop zone on UTG', el('mkDrop').hidden === true);
app.setMakeType('DC');
ok('DC manual label rendered correctly',
   el('mkOneSub').textContent === 'One drydocking certificate, filled in by hand.',
   el('mkOneSub').textContent);
app.setMakeType('DW');

console.log('\n--- H4. desktop width ---');
ok('entry paths share a grid wrapper', /class="mk-paths"/.test(html));
ok('paths go side by side on wide screens',
   /\.mk-paths\{display:grid;grid-template-columns:repeat\(auto-fit/.test(html));
ok('no narrow cap on the create surface', !/max-width:560px/.test(html));
ok('sub-tabs uncapped on desktop', /\.seg\.sub\{max-width:none/.test(html));

console.log('\n--- I. rename to RSR Billing ---');
ok('page title', /<title>RSR Billing<\/title>/.test(html));
ok('header', /<h1>RSR Billing<\/h1>/.test(html));
ok('gate', /<h2>RSR Billing<\/h2>/.test(html));
ok('no "Drawing Billing" left', !/Drawing Billing/.test(html));
ok('empty state generic', /Nothing billed yet/.test(html) && /Add a billing/.test(html));
ok('toast names the billing, not a drawing', /'Billing '\+code\+' added'/.test(html));
ok('statement subtotal says items', /Subtotal — \$\{list\.length\} item/.test(html));
ok('statement item column is not drawing-specific',
   /<th[^>]*>Description<\/th>/.test(html) && !/<th[^>]*>Drawing<\/th>/.test(html));
ok('rate label generic', /Rate per item/.test(html));

console.log('\n--- J. "drawing" survives inside the PDF import flow ---');
ok('drop copy kept', /Drop PDF drawings here/.test(html));
ok('import sheet title kept', /<h2 id="impTitle">Import drawings<\/h2>/.test(html));
ok('drop overlay kept', /Drop the drawing PDFs/.test(html));
ok('import rate label kept', /<label for="iRate">Rate per drawing/.test(html));

console.log('\n--- K. storage identifiers untouched ---');
ok('table name unchanged', /drawing_billing/.test(html) && !/create table if not exists rsr_billing/.test(html));
ok('bucket default unchanged', html.includes("cfg.bucket||'drawings'"));
ok('localStorage keys unchanged',
   /rsr_dwg_cfg_v1/.test(html) && /rsr_dwg_rows_v1/.test(html) &&
   /rsr_dwg_queue_v1/.test(html) && /rsr_dwg_catalog_v1/.test(html));
ok('columns unchanged', /drawing_no/.test(html) && /drawing_title/.test(html));

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
