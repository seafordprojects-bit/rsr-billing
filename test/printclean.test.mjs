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
const make = async (app, titles, date='2026-08-21') => {
  app.openEntry(null, 'DW');
  el('eClient').value = 'Seaford'; el('eVessel').value = 'MV SF Voyager';
  el('eDate').value = date; el('eRate').value = '1000';
  app.mlines = titles.map(t => ({ id:null, title:t, ref:'DWG-'+t.length, qty:1, rate:'',
                                  billable:true, rev_of:null, rev_no:null }));
  app.renderML();
  await el('eSave').onclick();
};
const openStmt = (app) => {
  el('sClient').value = 'Seaford';
  el('sFrom').value = '2026-08-01'; el('sTo').value = '2026-12-31';
  el('sType').value = ''; el('sTerms').value = '30'; el('sVat').value = '0';
  app.buildPick();
};
net.mode = 'offline';
let app = reset();

console.log('\n--- 1. no tracking codes on the client copy ---');
await make(app, ['Shell Expansion Plan', 'Midship Section']);
const g = app.allGroups()[0];
openStmt(app);
el('sNo').value = 'BILLDWG-26-001';
app.renderStatement(app.pickedRows());
const doc = el('printRoot').innerHTML;

ok('the tracking code is nowhere on the document', !doc.includes(g.code), g.code);
ok('no RSR- code of any shape', !/RSR-(DW|UT|DC|DWG)-\d/.test(doc),
   (doc.match(/RSR-[A-Z]+-\d+-\d+/) || [''])[0]);
ok('no TRACKING box in the meta strip', !/>Tracking</.test(doc));
ok('the billing number is shown', doc.includes('BILLDWG-26-001'));
ok('the meta strip keeps period, terms and due',
   /Period covered/.test(doc) && /Terms/.test(doc) && /Due on/.test(doc));
ok('the client drawing no. is still there', /DWG-/.test(doc),
   (doc.match(/DWG-\d+/) || [''])[0]);
ok('vessel still shown per line', /MV SF Voyager/.test(doc));

console.log('\n--- the footer references the billing number ---');
ok('footer names the billing number',
   /Please reference billing no\. BILLDWG-26-001 on payment advice/.test(doc),
   (doc.match(/Please reference[^<]*/) || [''])[0]);
ok('no longer says "billing code"', !/reference the billing code/.test(doc));

console.log('\n--- the emailed copy matches ---');
const mail = app.statementEmailHtml();
ok('email carries no tracking code', !mail.includes(g.code));
ok('email carries the billing number', mail.includes('BILLDWG-26-001'));
ok('email footer reworded', /Please reference billing no\./.test(mail));

console.log('\n--- Monitoring still shows tracking codes ---');
app.render();
ok('the code is on the Monitoring card', el('list').innerHTML.includes(g.code), g.code);
app.expanded = { [g.id]: true };
app.render();
ok('and still there when expanded', el('list').innerHTML.includes(g.code));

console.log('\n--- 2. line numbers stay on one line ---');
ok('numbers render as 1.0 and 2.0', doc.includes('>1.0<') && doc.includes('>2.0<'));
const pr = html.slice(html.indexOf('@media print{'), html.indexOf('@media print{') + 1600);
ok('break-word no longer applies to every cell',
   !/table\.stmt-t td\{word-wrap:break-word/.test(pr), pr.slice(0, 500));
ok('it is scoped to the description cell',
   /table\.stmt-t td\.d\{word-wrap:break-word/.test(pr));
ok('numeric columns cannot break', /\.c,table\.stmt-t \.r,table\.stmt-t \.cd\{white-space:nowrap/.test(pr));
ok('the number column is nowrap outside print too',
   /table\.stmt-t \.c\{[^}]*white-space:nowrap/.test(html));
ok('and the number column is sized in percent', /width:7%" class="c">No\./.test(html));
ok('the description cell is marked', /<td class="d">\$\{esc\(r\.drawing_title\)\}/.test(html));

console.log('\n--- 3. multi-billing guard ---');
app = reset();
await make(app, ['First Billing Line'], '2026-08-21');
await make(app, ['Second Billing Line'], '2026-09-02');
openStmt(app);
ok('two billings picked', app.pickedRows().length === 2, String(app.pickedRows().length));

let asked = null;
const realConfirm = globalThis.confirm;
globalThis.confirm = (m) => { asked = m; return false; };
el('sNo').value = '';
await el('sPrint').onclick();
ok('printing two billings asks first', !!asked, String(asked));
ok('the warning names both codes',
   app.pickedRows().every(x => asked.includes(x.code)), asked);
ok('it says one document is normally one billing',
   /normally one billing/.test(asked), asked);
ok('declining issues nothing',
   app.allGroups().every(x => !x.bill_no),
   JSON.stringify(app.allGroups().map(x => x.bill_no)));

asked = null;
globalThis.confirm = (m) => { asked = m; return true; };
await el('sPrint').onclick();
ok('accepting goes ahead', app.allGroups().every(x => !!x.bill_no),
   JSON.stringify(app.allGroups().map(x => x.bill_no)));
ok('each billing got its own number',
   new Set(app.allGroups().map(x => x.bill_no)).size === 2,
   JSON.stringify(app.allGroups().map(x => x.bill_no)));

console.log('\n--- a single billing is never questioned ---');
app = reset();
await make(app, ['Only One']);
openStmt(app);
asked = null;
el('sNo').value = '';
await el('sPrint').onclick();
ok('no prompt for one billing', asked === null, String(asked));
ok('and it issued', !!app.allGroups()[0].bill_no, String(app.allGroups()[0].bill_no));
globalThis.confirm = realConfirm;

console.log('\n--- the guard is on the email path too ---');
ok('email checks before sending',
   /\$\('sEmailBtn'\)\.onclick[\s\S]{0,700}confirmMultiGroup\(list\)/.test(html));
ok('preview flags it without blocking',
   /billings on one document — check this is what you want/.test(html));

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
