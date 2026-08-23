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
const reset = () => {
  KEYS.forEach(k => globalThis.localStorage.removeItem(k));
  globalThis.localStorage.setItem('rsr_dwg_cfg_v1', JSON.stringify({ seededDW:true }));
  el('sNo').value = '';
  return globalThis.__loadApp();
};
const ORDER = ['First Typed', 'Second Typed', 'Third Typed', 'Fourth Typed'];
const make = async (app, titles) => {
  app.openEntry(null, 'DW');
  el('eClient').value = 'Seaford'; el('eVessel').value = 'MV X';
  el('eDate').value = '2026-08-21'; el('eRate').value = '1000';
  app.mlines = titles.map(t => ({ id:null, title:t, ref:'', qty:1, rate:'',
                                  billable:true, rev_of:null, rev_no:null }));
  app.renderML();
  await el('eSave').onclick();
};
net.mode = 'offline';
let app = reset();

console.log('\n--- 2. lines keep the order they were entered ---');
await make(app, ORDER);
let g = app.allGroups()[0];
ok('four lines', g.count === 4, String(g.count));
ok('group lines are in entry order',
   g.lines.map(r => r.drawing_title).join(' | ') === ORDER.join(' | '),
   g.lines.map(r => r.drawing_title).join(' | '));
ok('line_no runs 0..3', g.lines.map(r => r.line_no).join(',') === '0,1,2,3',
   g.lines.map(r => r.line_no).join(','));

console.log('\n--- the Monitoring card lists them the same way ---');
app.expanded = { [g.id]: true };
app.render();
const card = el('list').innerHTML;
const cardOrder = [...card.matchAll(/class="t">([^<]+)/g)].map(m => m[1])
  .filter(t => ORDER.includes(t));
ok('expanded lines in entry order', cardOrder.join(' | ') === ORDER.join(' | '),
   cardOrder.join(' | '));
ok('numbered 1.0 first', card.indexOf('>1.0<') < card.indexOf('>4.0<'));
ok('1.0 is the first line typed',
   card.indexOf('First Typed') < card.indexOf('Second Typed'), cardOrder.join(' | '));

console.log('\n--- and so does the printed billing ---');
el('sClient').value = 'Seaford';
el('sFrom').value = '2026-08-01'; el('sTo').value = '2026-12-31';
el('sType').value = ''; el('sTerms').value = '30'; el('sVat').value = '0';
app.buildPick();
el('sNo').value = 'BILLDWG-26-001';
app.renderStatement(app.pickedRows());
const doc = el('printRoot').innerHTML;
const printed = [...doc.matchAll(/<td class="d">([^<]+)/g)].map(m => m[1].trim());
ok('printed in entry order', printed.join(' | ') === ORDER.join(' | '), printed.join(' | '));
ok('1.0 is the first line typed',
   doc.indexOf('First Typed') < doc.indexOf('Second Typed'));
ok('4.0 is the last', doc.indexOf('Fourth Typed') > doc.indexOf('Third Typed'));

console.log('\n--- the batch is no longer reversed on the way in ---');
ok('saveBatch inserts the whole list at once',
   /rows\.unshift\.apply\(rows,list\)/.test(html));
ok('and not one at a time inside the loop',
   !/list\.forEach\(row=>\{[\s\S]{0,120}rows\.unshift\(row\)/.test(html));

console.log('\n--- order survives a sync that returns rows shuffled ---');
const shuffled = g.lines.slice().reverse();
const restored = app.groupOf(shuffled);
ok('groupOf sorts by line_no',
   restored.lines.map(r => r.drawing_title).join(' | ') === ORDER.join(' | '),
   restored.lines.map(r => r.drawing_title).join(' | '));
const noOrdinals = ORDER.map((t, i) => ({ id:'x'+i, group_id:'g', drawing_title:t,
                                          qty:1, rate:1, status:'DRAFT' }));
ok('rows predating line_no keep their relative order',
   app.groupOf(noOrdinals).lines.map(r => r.drawing_title).join(' | ') === ORDER.join(' | '));

console.log('\n--- editing renumbers to what is on screen ---');
app.openEntry(g.id);
ok('editor loads in order', app.mlines.map(l => l.title).join(' | ') === ORDER.join(' | '),
   app.mlines.map(l => l.title).join(' | '));
app.mlines = [app.mlines[2], app.mlines[0], app.mlines[1], app.mlines[3]];
app.renderML();
await el('eSave').onclick();
g = app.allGroups()[0];
ok('the new order sticks',
   g.lines.map(r => r.drawing_title).join(' | ') ===
   ['Third Typed','First Typed','Second Typed','Fourth Typed'].join(' | '),
   g.lines.map(r => r.drawing_title).join(' | '));
ok('line_no renumbered 0..3', g.lines.map(r => r.line_no).join(',') === '0,1,2,3',
   g.lines.map(r => r.line_no).join(','));

console.log('\n--- a line added to a draft goes last ---');
app.openEntry(g.id);
app.mlines.push({ id:null, title:'Added Later', ref:'', qty:1, rate:'',
                  billable:true, rev_of:null, rev_no:null });
app.renderML();
await el('eSave').onclick();
g = app.allGroups()[0];
ok('appended at the end', g.lines[g.lines.length - 1].drawing_title === 'Added Later',
   g.lines.map(r => r.drawing_title).join(' | '));

console.log('\n--- the catalog picker keeps its tick order ---');
app = reset();
for (const [i, n] of ['Cat One','Cat Two','Cat Three'].entries())
  await app.catSave({ name:n, doc_type:'DC', drawing_no:'', default_rate:500,
                      sort_order:i, active:true }, true);
el('kClient').value = 'Seaford'; el('kVessel').value = '';
el('kDate').value = '2026-08-21'; el('kRate').value = '500'; el('kType').value = 'DC';
app.openCat('DC');
await el('kCommit').onclick();
const cg = app.allGroups()[0];
ok('catalog lines in catalog order',
   cg.lines.map(r => r.drawing_title).join(' | ') === 'Cat One | Cat Two | Cat Three',
   cg.lines.map(r => r.drawing_title).join(' | '));
ok('and numbered from zero', cg.lines.map(r => r.line_no).join(',') === '0,1,2',
   cg.lines.map(r => r.line_no).join(','));

console.log('\n--- 1. print margins ---');
const pr = html.slice(html.indexOf('@media print{'), html.indexOf('@media print{') + 2600);
// @page sits outside @media print, where Chrome honours it more reliably
ok('page rule is at the top level',
   html.indexOf('@page{') > -1 &&
   html.indexOf('@page{') < html.indexOf('@media print{'),
   '@page at ' + html.indexOf('@page{'));
ok('one balanced margin on all four sides', /@page\{size:auto;margin:12mm\}/.test(html),
   (html.match(/@page\{[^}]*\}/) || [''])[0]);
ok('body is not width-constrained', /html,body\{[\s\S]{0,140}max-width:none/.test(pr));
ok('the document takes the printable width', /\.stmt\{width:auto;max-width:none/.test(pr));
ok('printRoot adds no padding of its own', /#printRoot\{display:block !important;width:auto;margin:0;padding:0\}/.test(pr));
ok('border-box inside the document', /\.stmt \*\{box-sizing:border-box\}/.test(pr));
ok('backgrounds are kept', /print-color-adjust:exact/.test(pr));

console.log('\n--- table columns scale with the page ---');
ok('no fixed pixel column widths', !/<th style="width:\d+px"/.test(html),
   (html.match(/<th style="width:\d+px"[^>]*>/) || [''])[0]);
const pct = [...html.matchAll(/<th style="width:(\d+)%"/g)].map(m => +m[1]);
ok('five columns sized in percent', pct.length === 5, JSON.stringify(pct));
ok('they add up to exactly 100', pct.reduce((a, b) => a + b, 0) === 100,
   String(pct.reduce((a, b) => a + b, 0)));

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
