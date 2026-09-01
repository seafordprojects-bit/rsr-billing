import { fileURLToPath } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || path.join(ROOT, 'index.html');
import { net, mnlToday, codeStamp } from './harness.mjs';
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
// Fixtures ride the Manila clock, never a written-out month: a tracking code
// is stamped with the month the sheet was opened in. See harness.mjs.
const TODAY = mnlToday();
const MM = codeStamp();                 // MMYYYY, as it appears in a code
const DW1 = 'RSR-DW-' + MM + '-001';

const reset = () => {
  KEYS.forEach(k => globalThis.localStorage.removeItem(k));
  globalThis.localStorage.setItem('rsr_dwg_cfg_v1', JSON.stringify({ seededDW:true }));
  el('sNo').value = ''; document.activeElement = null;
  return globalThis.__loadApp();
};
const make = async (app, titles, o={}) => {
  app.setTab('new');
  app.setMakeType(o.type || 'DW');
  app.openEntry(null, o.type || 'DW');
  el('eClient').value = o.client || 'Seaford';
  el('eVessel').value = 'MV X';
  el('eDate').value = TODAY;
  el('eRate').value = o.rate || '10000';
  app.mlines = titles.map(t => ({ id:null, title:t, ref:'', qty:1, rate:'',
                                  billable:true, rev_of:null, rev_no:null }));
  app.renderML();
  await el('eSave').onclick();
};
net.mode = 'offline';
let app = reset();

console.log('\n--- the standing list is gone ---');
ok('no "Recently added" heading anywhere', !/Recently added/.test(html));
ok('no per-line card list on the create tab',
   !/mk-recent[\s\S]{0,200}<article class="row"/.test(html));
ok('nothing is rendered before anything is made',
   (app.setTab('new'), el('mkRecent').innerHTML === ''), el('mkRecent').innerHTML);

console.log('\n--- one line, only after creating ---');
await make(app, ['A Plan', 'B Plan', 'C Plan', 'D Plan']);
const line = el('mkRecent').innerHTML;
ok('a confirmation appears', /class="made"/.test(line), line.slice(0, 120));
ok('it names the billing once', line.split(DW1).length - 1 === 1,
   String(line.split(DW1).length - 1));
ok('it counts the items, not the lines separately', /4 items/.test(line), line);
ok('it shows the group total', /40,000/.test(line), line);
ok('it offers a way through to Monitoring', /View in Monitoring/.test(line));
ok('no DRAFT badge to misread as unsaved', !/badge/.test(line), line);
ok('and no status wording at all', !/DRAFT/.test(line));

console.log('\n--- a single-line billing reads naturally ---');
app = reset();
await make(app, ['Just One'], { rate:'2500' });
ok('singular item', /1 item,/.test(el('mkRecent').innerHTML), el('mkRecent').innerHTML);
ok('with its own total', /2,500/.test(el('mkRecent').innerHTML));

console.log('\n--- it disappears when you look elsewhere ---');
app = reset();
await make(app, ['A']);
ok('shown right after creating', /class="made"/.test(el('mkRecent').innerHTML));
app.setTab('mon');
app.setTab('new');
ok('gone after a tab switch', el('mkRecent').innerHTML === '', el('mkRecent').innerHTML);

await make(app, ['B']);
ok('shown again', /class="made"/.test(el('mkRecent').innerHTML));
app.setMakeType('DC');
ok('gone after a sub-tab switch', el('mkRecent').innerHTML === '', el('mkRecent').innerHTML);

console.log('\n--- View in Monitoring goes to that billing ---');
app = reset();
await make(app, ['Findable Plan', 'Second']);
const code = app.allGroups()[0].code;
const gid = app.allGroups()[0].id;
el('mkRecent').fire('click', { target: { closest: s => s === '[data-made]' ? {} : null } });
ok('switched to Monitoring', app.tab === 'mon', app.tab);
ok('searched for that billing', app.filters.q === code, app.filters.q);
ok('search box shows it', el('q').value === code, el('q').value);
ok('and the billing is expanded', app.expanded[gid] === true);
ok('the list actually finds it', app.visible().length === 1, String(app.visible().length));
ok('the confirmation is consumed', el('mkRecent').innerHTML === '' ||
   !/class="made"/.test(el('mkRecent').innerHTML), el('mkRecent').innerHTML);

console.log('\n--- the other two creation routes report too ---');
app = reset();
for (const [i, n] of ['Cat One','Cat Two'].entries())
  await app.catSave({ name:n, doc_type:'DC', drawing_no:'', default_rate:3000,
                      sort_order:i, active:true }, true);
app.setTab('new'); app.setMakeType('DC');
el('kClient').value = 'Seaford'; el('kVessel').value = '';
el('kDate').value = TODAY; el('kRate').value = '3000'; el('kType').value = 'DC';
app.openCat('DC');
await el('kCommit').onclick();
ok('the catalog picker confirms', /class="made"/.test(el('mkRecent').innerHTML),
   el('mkRecent').innerHTML);
ok('naming its billing', el('mkRecent').innerHTML.includes('RSR-DC-' + MM + '-001'));
ok('with the right count and total',
   /2 items, ₱6,000/.test(el('mkRecent').innerHTML), el('mkRecent').innerHTML);
ok('the PDF import reports as well', /noteMade\(gcode,built,gid,gcode\)/.test(html));

console.log('\n--- all three routes are wired ---');
ok('exactly three creation points call it',
   (html.match(/noteMade\(/g) || []).length === 4,   // 3 calls + the definition
   String((html.match(/noteMade\(/g) || []).length));

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
