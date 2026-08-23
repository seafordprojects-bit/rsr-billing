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
// One shared box, two inner dividers, no gaps.
ok('one outer border around the whole strip',
   /\.stmt-meta\{display:flex;border:1px solid #000/.test(html),
   (html.match(/\.stmt-meta\{[^}]*\}/) || [''])[0]);
ok('and no gap splitting it into separate boxes',
   !/\.stmt-meta\{[^}]*gap:/.test(html),
   (html.match(/\.stmt-meta\{[^}]*\}/) || [''])[0]);
ok('cells divided by a single inner rule each',
   /\.stmt-meta>div\{[^}]*border-left:1px solid #000/.test(html) &&
   /\.stmt-meta>div:first-child\{border-left:0\}/.test(html),
   (html.match(/\.stmt-meta>div[^{]*\{[^}]*\}/g) || []).join(' '));
ok('only one edge per cell carries a rule, so no doubling',
   !/border-right/.test((html.match(/\.stmt-meta[^{]*\{[^}]*\}/g) || []).join('')));
// The tick that survived two fixes: `.stmt-meta div` is a DESCENDANT
// selector, so it also matched the .k and .v divs nested in each cell and
// gave every label its own rule. `div:first-child` / `div:last-child` match
// those inner divs just as happily. Every cell rule must use `>`.
// (matched with a selector-boundary so the comment naming the bug in
// index.html does not trip it)
const badMeta = html.match(/\.stmt-meta div\s*[{:,.]/g) || [];
ok('no cell rule can reach the .k/.v divs inside',
   badMeta.length === 0, badMeta.join(' '));
ok('both stylesheets are scoped the same way',
   (html.match(/\.stmt-meta>div\{/g) || []).length === 2 &&
   (html.match(/\.stmt-meta>div:first-child\{/g) || []).length === 2,
   String((html.match(/\.stmt-meta>div\{/g) || []).length));
ok('the period cell keeps the extra width',
   /\.stmt-meta>div\.wide\{flex:1\.\d/.test(html) &&
   /<div class="wide"><div class="k">Period covered/.test(html));
ok('the client drawing no. is still there', /DWG-/.test(doc),
   (doc.match(/DWG-\d+/) || [''])[0]);
// One vessel for the billing, so it is named once in its own box and the
// lines carry only the client's drawing no.
ok('the vessel is named once, in its own box',
   /class="ves-box"><span class="k">Vessel name<\/span><span class="v">MV SF Voyager<\/span>/.test(doc),
   (doc.match(/class="ves-box"[\s\S]{0,90}/) || [''])[0]);
ok('and only once on the whole document',
   (doc.match(/MV SF Voyager/g) || []).length === 1,
   String((doc.match(/MV SF Voyager/g) || []).length));
ok('so no vessel sub-line under any item',
   !/<span class="sub">[^<]*MV SF Voyager/.test(doc),
   (doc.match(/<span class="sub">[^<]*/) || [''])[0]);
ok('the drawing no. sub-line survives on its own',
   /<span class="sub">DWG-\d+<\/span>/.test(doc),
   (doc.match(/<span class="sub">[^<]*/) || [''])[0]);
// Bill to is the client's data and nothing else
const billTo = (doc.match(/<div class="bill-to">[\s\S]*?<\/div>\s*<\/div>/) || [''])[0];
ok('Bill to no longer carries the vessel', !/MV SF Voyager/.test(billTo), billTo);
ok('the vessel box sits between Bill to and the meta row',
   doc.indexOf('bill-to') < doc.indexOf('ves-box') &&
   doc.indexOf('ves-box') < doc.indexOf('stmt-meta'));

console.log('\n--- payment terms default to 7 days ---');
app = reset();
await make(app, ['One Line']);
app.openStmt();
ok('a new billing opens on 7 days', el('sTerms').value === '7', el('sTerms').value);
ok('the field is still editable', !/id="sTerms"[^>]*readonly/.test(html));
ok('the markup fallback matches the default',
   /id="sTerms"[^>]*value="7"/.test(html),
   (html.match(/id="sTerms"[^>]*>/) || [''])[0]);
el('sClient').value = 'Seaford';
el('sFrom').value = '2026-08-01'; el('sTo').value = '2026-12-31'; el('sVat').value = '0';
app.buildPick();
app.renderStatement(app.pickedRows());
ok('and prints as "7 days"',
   /<div class="k">Terms<\/div><div class="v mono">7 days<\/div>/.test(el('printRoot').innerHTML),
   (el('printRoot').innerHTML.match(/Terms<\/div><div class="v mono">[^<]*/) || [''])[0]);

// editable per billing, without disturbing the default
el('sTerms').value = '45';
app.renderStatement(app.pickedRows());
ok('an override prints instead',
   /<div class="v mono">45 days</.test(el('printRoot').innerHTML));
app.openStmt();
ok('and the next billing is back to the default',
   el('sTerms').value === '7', el('sTerms').value);

console.log('\n--- and are configurable in Settings ---');
ok('Settings has the field', /id="cTerms"/.test(html));
app.cfg.terms = 15;
app.openCfg();
ok('Settings shows the stored value', el('cTerms').value === '15', el('cTerms').value);
app.openStmt();
ok('new billings follow it', el('sTerms').value === '15', el('sTerms').value);
// 0 means due on issue and must not be mistaken for "unset"
app.cfg.terms = 0;
app.openStmt();
ok('zero survives as a real term', el('sTerms').value === '0', el('sTerms').value);
app.cfg.terms = '';
app.openStmt();
ok('but a blank value falls back to 7', el('sTerms').value === '7', el('sTerms').value);
app.cfg.terms = -5;
app.openStmt();
ok('and so does a negative one', el('sTerms').value === '7', el('sTerms').value);

// the same clamp on the way in from the Settings form
app.openCfg();
el('cTerms').value = '21';
await el('cSave').onclick();
ok('saving Settings stores the new default', app.cfg.terms === 21, String(app.cfg.terms));
app.openCfg();
el('cTerms').value = '0';
await el('cSave').onclick();
ok('and stores a deliberate zero', app.cfg.terms === 0, String(app.cfg.terms));
app.openCfg();
el('cTerms').value = '';
await el('cSave').onclick();
ok('an emptied box goes back to 7, not to 0',
   app.cfg.terms === 7, String(app.cfg.terms));

console.log('\n--- the page margins cannot be eaten ---');
ok('@page declares the 12mm margin',
   /@page\{size:auto;margin:12mm\}/.test(html),
   (html.match(/@page\{[^}]*\}/) || [''])[0]);
ok('exactly one @page rule, so none can override it',
   (html.match(/@page\{/g) || []).length === 1,
   String((html.match(/@page\{/g) || []).length));
ok('and it is outside @media print',
   html.indexOf('@page{') < html.indexOf('@media print{'));
ok('the side inset that survives Margins:None is still there',
   /\.stmt\{width:auto;max-width:none;margin:0;padding:0 4mm/.test(html));
// Overflow spills into the @page margin rather than clipping at the page
// box, so anything that cannot shrink eats the side margins.
ok('every flex child in the statement may shrink',
   /\.stmt-hd>div\{min-width:0\}/.test(html) &&
   /\.stmt-meta>div\{flex:1;min-width:0/.test(html) &&
   /\.ves-box \.v\{min-width:0/.test(html));
ok('and long single-token values have somewhere to break',
   /\.stmt-hd h1,\.stmt-hd p\{overflow-wrap:break-word\}/.test(html) &&
   /\.bill-to \.who,\.bill-to \.co,\.bill-to \.ad\{overflow-wrap:break-word\}/.test(html));
ok('the mark and the billing number keep their size',
   /\.stmt-hd \.m\{flex:0 0 auto/.test(html) &&
   /\.stmt-hd \.rt\{margin-left:auto;text-align:right;flex:0 0 auto\}/.test(html));
ok('nothing in the statement declares a width wider than its box',
   !/\.stmt[^{]*\{[^}]*width:\d+(mm|cm|in)/.test(html));

console.log('\n--- no footer strip ---');
// The payment-advice line is gone, and with it the strip: the only other
// thing on it was today's date, which the header block already prints.
ok('no payment-advice line', !/payment advice/.test(doc),
   (doc.match(/Please reference[^<]*/) || [''])[0]);
ok('no longer says "billing code"', !/reference the billing code/.test(doc));
ok('the footer strip went with it', !/stmt-ft/.test(doc));

console.log('\n--- the emailed copy matches ---');
const mail = app.statementEmailHtml();
ok('email carries no tracking code', !mail.includes(g.code));
ok('email carries the billing number', mail.includes('BILLDWG-26-001'));
ok('email drops the footer too',
   !/payment advice/.test(mail) && !/stmt-ft/.test(mail));

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

console.log('\n--- mixed vessels fall back to per-line ---');
// A PDF import can set a different vessel per file, and a statement can cover
// more than one group. Naming one vessel in the header would then be a lie,
// so that billing keeps its sub-lines.
app = reset();
await make(app, ['Shell Expansion Plan', 'Midship Section']);
const mixed = app.allGroups()[0];
mixed.lines[1].vessel = 'MV SF Cruiser';
openStmt(app);
el('sNo').value = 'BILLDWG-26-002';
app.renderStatement(app.pickedRows());
const two = el('printRoot').innerHTML;
ok('no single-vessel line under Bill to', !/ves-box/.test(two),
   (two.match(/class="ves-box"[\s\S]{0,90}/) || [''])[0]);
ok('both vessels are on their own lines',
   /<span class="sub">MV SF Voyager · DWG-/.test(two) &&
   /<span class="sub">MV SF Cruiser · DWG-/.test(two),
   (two.match(/<span class="sub">[^<]*/g) || []).join(' | '));

console.log('\n--- casing and spacing are not a second vessel ---');
app = reset();
await make(app, ['Shell Expansion Plan', 'Midship Section']);
const cased = app.allGroups()[0];
cased.lines[1].vessel = '  MV SF   VOYAGER ';
openStmt(app);
el('sNo').value = 'BILLDWG-26-003';
app.renderStatement(app.pickedRows());
const one = el('printRoot').innerHTML;
ok('still one vessel, still in the header',
   /class="ves-box"><span class="k">Vessel name<\/span><span class="v">MV SF Voyager<\/span>/.test(one),
   (one.match(/class="ves-box"[\s\S]{0,90}/) || [''])[0]);
ok('the first line\'s spelling is the one printed',
   !/MV SF   VOYAGER/.test(one) && !/VOYAGER<\/b>/.test(one));
ok('and it did not fall back to per-line',
   !/<span class="sub">[^<]*MV SF/i.test(one),
   (one.match(/<span class="sub">[^<]*/g) || []).join(' | '));

console.log('\n--- company contact no. ---');
app = reset();
await make(app, ['One Line']);
openStmt(app);
el('sNo').value = 'BILLDWG-26-003';
app.renderStatement(app.pickedRows());
ok('omitted when the field is empty',
   !/contact no\./.test(el('printRoot').innerHTML));
app.cfg.contactNo = '+63 917 000 0000 / +63 32 000 0000';
app.renderStatement(app.pickedRows());
const hd = el('printRoot').innerHTML;
ok('printed under the address when set',
   /contact no\.: \+63 917 000 0000 \/ \+63 32 000 0000/.test(hd),
   (hd.match(/contact no\.[^<]*/) || [''])[0]);
ok('it sits in the header block, not the meta strip',
   hd.indexOf('contact no.') < hd.indexOf('stmt-meta'));
ok('the field is in Settings company details', /id="cContactNo"/.test(html));
// openCfg touches every id in the panel; a missing one throws and takes the
// whole IIFE with it, so call it rather than grepping for the wiring
app.openCfg();
ok('Settings loads the stored value into the field',
   el('cContactNo').value === '+63 917 000 0000 / +63 32 000 0000',
   el('cContactNo').value);

console.log('\n--- Bill to keeps the contact person above the company ---');
app = reset();
await app.cliSave({ name:'Seaford', contact_person:'Ashford Chua',
                    address:'Cebu', billing_email:'' }, true);
await make(app, ['One Line']);
openStmt(app);
app.renderStatement(app.pickedRows());
const bt = el('printRoot').innerHTML;
ok('contact person prints as .who',
   /<div class="who">Ashford Chua<\/div>/.test(bt),
   (bt.match(/class="bill-to"[\s\S]{0,220}/) || [''])[0]);
ok('above the company name',
   bt.indexOf('>Ashford Chua<') < bt.indexOf('class="co"'));

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
