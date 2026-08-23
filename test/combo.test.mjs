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
              'rsr_dwg_catalog_v1','rsr_dwg_clients_v1'];
// seededDW suppresses the MARINA seed so these cases run against a known
// catalog; seeding itself is covered in seed.test.mjs
const reset = () => {
  KEYS.forEach(k => globalThis.localStorage.removeItem(k));
  globalThis.localStorage.setItem('rsr_dwg_cfg_v1', JSON.stringify({ seededDW: true }));
  return globalThis.__loadApp();
};
net.mode = 'offline';
let app = reset();

console.log('\n--- A. line rows are title + rate only ---');
app.openEntry(null, 'DW');
const row = el('mlList').innerHTML;
ok('title field present', /data-mlf="title"/.test(row));
ok('rate field present', /data-mlf="rate"/.test(row));
ok('ref column removed', !/data-mlf="ref"/.test(row), row.slice(0, 200));
ok('qty column removed', !/data-mlf="qty"/.test(row));
ok('qty is still 1 internally', app.mlines[0].qty === 1, String(app.mlines[0].qty));

console.log('\n--- B. rate still prefills from the batch default ---');
el('eClient').value = 'Seaford'; el('eDate').value = '2026-08-21'; el('eRate').value = '1500';
app.mlines[0].title = 'Free Text Item';
await el('eSave').onclick();
ok('line inherits the batch rate', app.rows[0].rate === 1500, String(app.rows[0].rate));
ok('qty 1 on the record', app.rows[0].qty === 1);

console.log('\n--- C. substring, case-insensitive matching ---');
app = reset();
for (const [n, r] of [['Shell Expansion Plan', 2500], ['Midship Section', null],
                      ['Capacity Plan', 4000]])
  await app.catSave({ name:n, doc_type:'DW', drawing_no:'', default_rate:r,
                      sort_order:0, active:true }, true);
await app.catSave({ name:'UTG Hull Survey', doc_type:'UT', drawing_no:'', default_rate:null,
                    sort_order:0, active:true }, true);
app.openEntry(null, 'DW');
const names = q => app.titleSuggest(q).map(i => i.label);
ok('typing "sh" suggests Shell Expansion Plan',
   names('sh').includes('Shell Expansion Plan'), names('sh').join(' | '));
ok('matches anywhere, not just the start',
   names('pansion').includes('Shell Expansion Plan'), names('pansion').join(' | '));
ok('case-insensitive', names('SHELL').includes('Shell Expansion Plan'));
ok('"plan" finds both plans',
   names('plan').includes('Shell Expansion Plan') && names('plan').includes('Capacity Plan'),
   names('plan').join(' | '));
ok('only the active tab type is offered',
   !names('').includes('UTG Hull Survey'), names('').join(' | '));
ok('an empty query lists that type', names('').length === 3, names('').join(' | '));

console.log('\n--- D. picking applies the catalog default rate ---');
el('eRate').value = '1000';
const shell = app.catalog.find(c => c.name === 'Shell Expansion Plan');
app.mlApply(0, shell);
ok('title taken', app.mlines[0].title === 'Shell Expansion Plan');
ok('own rate applied over the batch default',
   String(app.mlines[0].rate) === '2500', String(app.mlines[0].rate));
const mid = app.catalog.find(c => c.name === 'Midship Section');
app.mlines.push({ title:'', ref:'', qty:1, rate:'' });
app.mlApply(1, mid);
ok('an item with no default leaves the line blank',
   app.mlines[1].rate === '', JSON.stringify(app.mlines[1].rate));
ok('so it bills at the batch rate', app.mlRate(app.mlines[1]) === 1000,
   String(app.mlRate(app.mlines[1])));

console.log('\n--- E. free text is still allowed ---');
app.mlines.push({ title:'Something Not In The Catalog', ref:'', qty:1, rate:'' });
app.renderML();
el('eClient').value = 'Seaford'; el('eDate').value = '2026-08-21';
await el('eSave').onclick();
ok('free-text line created',
   app.rows.some(r => r.drawing_title === 'Something Not In The Catalog'));
ok('catalog-picked line created too',
   app.rows.some(r => r.drawing_title === 'Shell Expansion Plan'));

console.log('\n--- F. keyboard navigation ---');
app = reset();
await app.catSave({ name:'Alpha Plan', doc_type:'DW', default_rate:null, sort_order:0, active:true }, true);
await app.catSave({ name:'Beta Plan',  doc_type:'DW', default_rate:null, sort_order:1, active:true }, true);
app.openEntry(null, 'DW');
let picked = null;
const pop = { hidden:true, innerHTML:'' };
app.cmbShow({ value:'' }, pop, app.titleSuggest(''), it => { picked = it.label; });
ok('popup opens with items', pop.hidden === false && app.cmbOpen.items.length === 2);
ok('nothing highlighted initially', app.cmbOpen.sel === -1, String(app.cmbOpen.sel));
app.cmbMove(1);
ok('down highlights the first', app.cmbOpen.sel === 0);
app.cmbMove(1);
ok('down again highlights the second', app.cmbOpen.sel === 1);
app.cmbMove(1);
ok('down past the end clears the selection', app.cmbOpen.sel === -1);
app.cmbMove(-1);
ok('up from none wraps to the last', app.cmbOpen.sel === 1, String(app.cmbOpen.sel));
ok('the active row is marked', /class="act"/.test(pop.innerHTML), pop.innerHTML.slice(0, 140));
app.cmbTake();
ok('enter picks the highlighted item', picked === 'Beta Plan', String(picked));
ok('and closes the popup', pop.hidden === true && app.cmbOpen === null);

console.log('\n--- G. client typeahead everywhere ---');
app = reset();
await app.cliSave({ name:'Seaford Shipping Lines', contact_person:'Ms. Ana Cruz',
                    address:'Pier 4, Cebu City', billing_email:'ap@seaford.test' }, true);
app.rows.push({ id:'x', code:'RSR-DW-082026-001', doc_type:'DW', bill_date:'2026-08-01',
                client:'Cebu Drydock Corp', drawing_title:'T', qty:1, rate:1, status:'DRAFT' });
const cs = q => app.clientSuggest(q).map(i => i.label);
ok('suggests from the clients table',
   cs('sea').includes('Seaford Shipping Lines'), cs('sea').join(' | '));
ok('and from clients already on records',
   cs('cebu').includes('Cebu Drydock Corp'), cs('cebu').join(' | '));
ok('matches anywhere', cs('drydock').includes('Cebu Drydock Corp'));
ok('case-insensitive', cs('SEAFORD').length === 1);
ok('contact and address shown as the hint',
   app.clientSuggest('sea')[0].sub.includes('Ms. Ana Cruz') &&
   app.clientSuggest('sea')[0].sub.includes('Pier 4'),
   app.clientSuggest('sea')[0].sub);
ok('no duplicate when a name is in both sources',
   app.clientSuggest('').filter(i => i.label === 'Seaford Shipping Lines').length === 1);

for (const id of ['eClient','iClient','kClient'])
  ok(id + ' is wired as a combo', new RegExp('id="' + id + 'Pop"').test(html));
ok('the client datalist no longer drives these inputs',
   !/id="eClient" list="dlClients"/.test(html) &&
   !/id="iClient" list="dlClients"/.test(html) &&
   !/id="kClient" list="dlClients"/.test(html));

console.log('\n--- H. picking a client fills the billing document ---');
el('sClient').value = 'Seaford Shipping Lines';
el('sFrom').value = '2026-08-01'; el('sTo').value = '2026-08-31';
el('sTerms').value = '30'; el('sVat').value = '0'; el('sNo').value = 'BILLDWG-26-001';
app.rows.push({ id:'y', code:'RSR-DW-082026-002', doc_type:'DW', bill_date:'2026-08-02',
                client:'Seaford Shipping Lines', drawing_title:'Shell', qty:1,
                rate:1000, status:'DRAFT' });
app.renderStatement([app.rows[1]]);
const doc = el('printRoot').innerHTML;
ok('contact person auto-filled', /Ms\. Ana Cruz/.test(doc));
ok('address auto-filled', /Pier 4, Cebu City/.test(doc));

console.log('\n--- I. a new client name is remembered ---');
app = reset();
app.openEntry(null, 'DW');
el('eClient').value = 'Brand New Yard'; el('eDate').value = '2026-08-21'; el('eRate').value = '900';
app.mlines[0].title = 'A Plan';
await el('eSave').onclick();
ok('client saved for next time', !!app.clients.find(c => c.name === 'Brand New Yard'),
   JSON.stringify(app.clients.map(c => c.name)));
ok('it now suggests', app.clientSuggest('brand').length === 1);
const before = app.clients.length;
await app.rememberClient('Brand New Yard');
ok('remembering twice does not duplicate', app.clients.length === before);

console.log('\n--- K. the popup can actually be seen ---');
// The popup is position:absolute, so it lands on its nearest POSITIONED
// ancestor. `.ml-row .cmb` was the only rule declaring position:relative,
// so the three client comboboxes resolved against `.sheet` instead: with
// left:0;right:0 they spanned the sheet, and top:calc(100% + 4px) put them
// just below the sheet's bottom edge — which is the bottom of the screen.
// The list populated and unhid correctly; it was painted off-screen.
// comments stripped first, or the prose above a rule is read as part of its
// selector and `.cmb{` never matches at the start
const css = html.slice(0, html.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');
const cmbRules = (css.match(/(^|\})([^{}]*\.cmb[^{}]*)\{([^}]*)\}/gm) || [])
  .map(r => r.replace(/^\}/, '').trim());
const popRule = (html.match(/\.cmb-pop\{[^}]*\}/) || [''])[0];
ok('the popup is absolutely positioned', /position:absolute/.test(popRule), popRule);
ok('so it is offset from its container, not the page',
   /top:calc\(100% \+ \d+px\)/.test(popRule), popRule);
// the fix: an unscoped rule, so every .cmb wrapper is a containing block
const bare = cmbRules.filter(r => /^\.cmb\{/.test(r));
ok('a bare .cmb rule exists', bare.length === 1, cmbRules.join(' | '));
ok('and it makes the wrapper positioned',
   bare.length === 1 && /position:relative/.test(bare[0]), bare[0] || '');
// every wrapper in the markup must be covered by it, not just the ml-row one
const wrappers = (html.match(/<div class="cmb">/g) || []).length;
ok('all four wrappers share that one class', wrappers === 4, String(wrappers));
ok('the ml-row rule no longer has to carry positioning on its own',
   /\.ml-row \.cmb\{/.test(html));

console.log('\n--- every client entry point opens a visible list ---');
app = reset();
await app.cliSave({ name:'Seaford Shipping Lines', contact_person:'Mr. Chua',
                    address:'Cebu', billing_email:'ap@sea.test' }, true);
app.openEntry(null, 'DW');
app.openImport();
app.openCat();
for (const id of ['eClient', 'iClient', 'kClient']) {
  const inp = el(id), pop = el(id + 'Pop');
  ok(id + ' is wired for input and focus',
     Object.keys(inp._on || {}).includes('input') &&
     Object.keys(inp._on || {}).includes('focus'),
     Object.keys(inp._on || {}).join(','));
  // focus alone offers the whole list
  inp.value = '';
  inp.fire('focus', { target: inp });
  ok(id + ' offers every client on focus',
     pop.hidden === false && pop.innerHTML.includes('Seaford Shipping Lines'),
     'hidden=' + pop.hidden);
  // typing filters it
  inp.value = 'sea';
  inp.fire('input', { target: inp });
  ok(id + ' filters as you type "sea"',
     pop.hidden === false && pop.innerHTML.includes('Seaford Shipping Lines'),
     'hidden=' + pop.hidden + ' html=' + String(pop.innerHTML).slice(0, 60));
  ok(id + ' shows the client detail line',
     pop.innerHTML.includes('ap@sea.test'), String(pop.innerHTML).slice(0, 120));
  // a miss closes it rather than showing an empty box
  inp.value = 'zzzz';
  inp.fire('input', { target: inp });
  ok(id + ' hides again when nothing matches', pop.hidden === true);
  // and picking one fills the field
  inp.value = 'sea';
  inp.fire('input', { target: inp });
  app.cmbTake(0);
  ok(id + ' takes the pick into the field',
     inp.value === 'Seaford Shipping Lines' && pop.hidden === true, inp.value);
}

console.log('\n--- J. the printed billing is untouched by this change ---');
ok('numbered 1.0 list kept', html.includes('${i+1}.0'));
ok('Description column kept', /<th[^>]*>Description<\/th>/.test(html));

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
