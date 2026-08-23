import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || path.join(ROOT, 'index.html');
const FN_SRC = path.join(ROOT, 'supabase', 'functions', 'send-statement', 'index.ts');
// Caret and focus survival in the Settings editors: a repaint must not move
// the caret into a neighbouring field.
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
  document.activeElement = null;
  return globalThis.__loadApp();
};
const field = (boxId, f, i) =>
  el(boxId).querySelector('[data-' + f + '="' + i + '"][data-ti="' + i + '"]') ||
  el(boxId).children.find(c => c.dataset[f] !== undefined && String(c.dataset.ti) === String(i));
const fieldBy = (boxId, fKey, fVal, iKey, iVal) =>
  el(boxId).children.find(c => String(c.dataset[fKey]) === fVal &&
                               String(c.dataset[iKey]) === String(iVal));
// type a character the way the browser would: update the element, then fire input
const typeInto = (boxId, node, text) => {
  node.focus();
  node.value = text;
  node.selectionStart = text.length;
  el(boxId).fire('input', { target: { closest: sel =>
    sel.startsWith('[data-') ? node : null } });
};

net.mode = 'offline';
let app = reset();
app.renderTypes();
const DW = app.cfg.types.findIndex(t => t.code === 'DW');

console.log('\n--- the panel renders real, addressable fields ---');
const seq = fieldBy('cTypeList', 'tf', 'seq', 'ti', DW);
const label = fieldBy('cTypeList', 'tf', 'label', 'ti', DW);
const code = fieldBy('cTypeList', 'tf', 'code', 'ti', DW);
ok('counter field exists', !!seq);
ok('name field exists', !!label, label && label.value);
ok('code field exists', !!code, code && code.value);
ok('the name field holds the type name', label.value === 'Drawing', label.value);

console.log('\n--- typing in the counter never reaches the name ---');
typeInto('cTypeList', seq, '0');
ok('name untouched by a 0', app.cfg.types[DW].label === 'Drawing', app.cfg.types[DW].label);
typeInto('cTypeList', seq, '13');
ok('name untouched by 13', app.cfg.types[DW].label === 'Drawing', app.cfg.types[DW].label);
ok('code untouched', app.cfg.types[DW].code === 'DW', app.cfg.types[DW].code);
ok('billing prefix untouched', app.cfg.types[DW].bill === 'BILLDWG', app.cfg.types[DW].bill);
ok('and the counter itself is not committed yet', app.billSeqOf('DW') === 0,
   String(app.billSeqOf('DW')));

console.log('\n--- a repaint puts the caret back where it was ---');
const before = fieldBy('cTypeList', 'tf', 'label', 'ti', DW);
before.focus();
before.value = 'Drawing';
before.selectionStart = 4;
ok('focus is on the name field', document.activeElement === before);
app.renderTypes();
const after = document.activeElement;
ok('focus survives the repaint', !!after, String(after));
ok('and is still the name field', after && after.dataset.tf === 'label',
   after && after.dataset.tf);
ok('on the same row', after && String(after.dataset.ti) === String(DW),
   after && after.dataset.ti);
ok('not the counter beside it', after && after.dataset.tf !== 'seq');
ok('caret position restored', after && after.selectionStart === 4,
   String(after && after.selectionStart));
ok('the node is the fresh one, not the discarded one', after !== before);

console.log('\n--- focus on the counter survives too ---');
const seq2 = fieldBy('cTypeList', 'tf', 'seq', 'ti', DW);
seq2.focus();
app.renderTypes();
ok('still on the counter', document.activeElement &&
   document.activeElement.dataset.tf === 'seq',
   document.activeElement && document.activeElement.dataset.tf);
ok('and on the same row', String(document.activeElement.dataset.ti) === String(DW));

console.log('\n--- a repaint with nothing focused does not steal focus ---');
document.activeElement = null;
app.renderTypes();
ok('focus stays nowhere', document.activeElement === null,
   document.activeElement && document.activeElement.dataset);

console.log('\n--- focus outside the panel is left alone ---');
el('cPayee').focus();
app.renderTypes();
ok('an unrelated field keeps focus', document.activeElement === el('cPayee'));

console.log('\n--- the same protection on the other editors ---');
app = reset();
await app.cliSave({ name:'Seaford', contact_person:'Ms Cruz', address:'Cebu',
                    billing_email:'ap@seaford.test' }, true);
app.renderCliMgr();
const cid = app.clients[0].id;
const cname = fieldBy('cCliList', 'clf', 'name', 'cli', cid);
ok('client name field found', !!cname, cname && cname.value);
cname.focus(); cname.selectionStart = 3;
app.renderCliMgr();
ok('client editor keeps focus', document.activeElement &&
   document.activeElement.dataset.clf === 'name',
   document.activeElement && document.activeElement.dataset.clf);
ok('and its caret', document.activeElement.selectionStart === 3,
   String(document.activeElement.selectionStart));

app = reset();
await app.catSave({ name:'Shell Expansion', doc_type:'DW', drawing_no:'', default_rate:null,
                    sort_order:0, active:true }, true);
app.renderCatMgr();
const kid = app.catalog[0].id;
const cat = fieldBy('cCatList', 'cf', 'name', 'ci', kid);
ok('catalog name field found', !!cat);
cat.focus(); cat.selectionStart = 5;
app.renderCatMgr();
ok('catalog editor keeps focus', document.activeElement &&
   document.activeElement.dataset.cf === 'name',
   document.activeElement && document.activeElement.dataset.cf);
ok('and its caret', document.activeElement.selectionStart === 5);

app.renderBanks();
const bank = fieldBy('cBankList', 'bkf', 'bank', 'bki', 0);
ok('bank field found', !!bank);
bank.focus(); bank.selectionStart = 2;
app.renderBanks();
ok('bank editor keeps focus', document.activeElement &&
   document.activeElement.dataset.bkf === 'bank',
   document.activeElement && document.activeElement.dataset.bkf);
ok('and the right row', String(document.activeElement.dataset.bki) === '0');

console.log('\n--- the mechanism is in place, not incidental ---');
ok('a shared repaint helper exists', /function repaint\(box,html,keys\)/.test(html));
ok('it records the focused field', /document\.activeElement/.test(html));
ok('and restores the caret', /setSelectionRange\(keep\.pos,keep\.pos\)/.test(html));
ok('all four editors go through it',
   (html.match(/repaint\(\$\('c(TypeList|CliList|CatList|BankList)'\)/g) || []).length === 4,
   String((html.match(/repaint\(\$\('c\w+'\)/g) || []).length));
ok('no editor writes innerHTML directly any more',
   !/\$\('c(TypeList|CliList|CatList|BankList)'\)\.innerHTML=/.test(html));

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
