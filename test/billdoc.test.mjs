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
const YY = String(new Date().getFullYear()).slice(2);
const reset = () => {
  KEYS.forEach(k => globalThis.localStorage.removeItem(k));
  globalThis.localStorage.setItem('rsr_dwg_cfg_v1', JSON.stringify({ seededDW:true }));
  return globalThis.__loadApp();
};
const makeBilling = async (app, type, titles, client='Seaford') => {
  app.openEntry(null, type);
  el('eClient').value = client; el('eVessel').value = 'MV X';
  el('eDate').value = '2026-08-21'; el('eRate').value = '1000';
  app.mlines = titles.map(t => ({ id:null, title:t, ref:'', qty:1, rate:'' }));
  app.renderML();
  await el('eSave').onclick();
  return app.allGroups()[0];
};
const openStmtFor = (app, client='Seaford') => {
  el('sNo').value = '';          // the stub keeps elements across reloads
  el('sClient').value = client;
  el('sFrom').value = '2026-08-01'; el('sTo').value = '2026-08-31';
  el('sType').value = ''; el('sTerms').value = '30'; el('sVat').value = '0';
  app.buildPick();
};
net.mode = 'offline';
let app = reset();

console.log('\n--- C1. the number is claimed once and stored on the billing ---');
await makeBilling(app, 'DW', ['Line A', 'Line B']);
openStmtFor(app);
ok('nothing issued yet', !app.allGroups()[0].bill_no);
app.refreshBillNo(true);
ok('field previews the next number', el('sNo').value === `BILLDWG-${YY}-001`, el('sNo').value);
ok('and says it is not claimed yet', /^auto — will issue as /.test(el('sNoHint').textContent),
   el('sNoHint').textContent);

const first = await app.issueBillNos();
ok('issuing returns the number', first === `BILLDWG-${YY}-001`, first);
ok('stored on the billing', app.allGroups()[0].bill_no === first, app.allGroups()[0].bill_no);
ok('stored on every line', app.rows.every(r => r.bill_no === first),
   JSON.stringify(app.rows.map(r => r.bill_no)));

const second = await app.issueBillNos();
ok('a later print reuses it', second === first, second);
ok('the counter did not move', app.nextBillNo('DW') === `BILLDWG-${YY}-002`,
   app.nextBillNo('DW'));
const third = await app.issueBillNos();
ok('and again', third === first, third);

console.log('\n--- C2. a second billing gets the next number ---');
await makeBilling(app, 'DW', ['Other']);
openStmtFor(app);
const gs = app.allGroups();
ok('two billings now', gs.length === 2, String(gs.length));
const unissued = gs.find(g => !g.bill_no);
ok('the new one has no number yet', !!unissued);
await app.issueBillNos();
ok('the new one took 002',
   app.allGroups().find(g => g.id === unissued.id).bill_no === `BILLDWG-${YY}-002`,
   app.allGroups().find(g => g.id === unissued.id).bill_no);
ok('the first one kept 001',
   app.allGroups().find(g => g.bill_no === `BILLDWG-${YY}-001`) !== undefined);

console.log('\n--- C3. the stored number is editable while DRAFT ---');
app = reset();
const g1 = await makeBilling(app, 'DC', ['Cert A']);
openStmtFor(app);
await app.issueBillNos();
ok('issued', app.allGroups()[0].bill_no === `BILLDC-${YY}-001`);
el('sNo').value = 'BILLDC-26-077'; el('sNo').fire('input', {});
const edited = await app.issueBillNos();
ok('a draft billing accepts an edited number', edited === 'BILLDC-26-077', edited);
ok('and stores it', app.allGroups()[0].bill_no === 'BILLDC-26-077');
app.markGroup(app.allGroups()[0].id, 'BILLED');
openStmtFor(app);
ok('a billed one is not offered a reset',
   /issued as/.test(el('sNoHint').textContent) &&
   !/reset to auto/.test(el('sNoHint').textContent) &&
   el('sNoReset').hidden === true, el('sNoHint').textContent);

console.log('\n--- C4. preview claims nothing ---');
app = reset();
await makeBilling(app, 'DW', ['Preview Me']);
openStmtFor(app);
const before = app.nextBillNo('DW');
el('sPreview').onclick();
ok('no number claimed', app.allGroups()[0].bill_no === undefined ||
   !app.allGroups()[0].bill_no, String(app.allGroups()[0].bill_no));
ok('counter untouched', app.nextBillNo('DW') === before, app.nextBillNo('DW'));
ok('document marked as a preview', /Preview — not yet issued/.test(el('printRoot').innerHTML));
ok('nothing was marked billed', app.allGroups()[0].status === 'DRAFT');

console.log('\n--- C5. per-type counter reset ---');
app = reset();
await app.setBillSeq('DW', 4);
ok('counter set to 4', app.billSeqOf('DW') === 4, String(app.billSeqOf('DW')));
ok('next is 005', app.nextBillNo('DW') === `BILLDWG-${YY}-005`, app.nextBillNo('DW'));
await app.setBillSeq('DW', 0);
ok('a reset can go backwards', app.billSeqOf('DW') === 0, String(app.billSeqOf('DW')));
ok('next is 001 again', app.nextBillNo('DW') === `BILLDWG-${YY}-001`, app.nextBillNo('DW'));
ok('other types untouched', app.billSeqOf('DC') === 0 && app.billSeqOf('UT') === 0);
ok('the reset is shared, not device-local',
   app.queue.some(j => j.op === 'upsert' && j.key === 'billseq:DW'),
   JSON.stringify(app.queue.map(j => j.key)));
app.renderTypes();
ok('Settings offers a per-type counter control', /data-treset=/.test(el('cTypeList').innerHTML));
ok('showing the current value', /data-tf="seq"/.test(el('cTypeList').innerHTML));

console.log('\n--- B. client billing email ---');
app = reset();
await app.cliSave({ name:'Seaford', contact_person:'Ms. Cruz', address:'Cebu',
                    billing_email:'ap@seaford.test' }, true);
ok('billing_email is editable in Settings',
   /data-clf="billing_email"/.test(html));
ok('it shows in the typeahead hint',
   app.clientSuggest('sea')[0].sub.includes('ap@seaford.test'),
   app.clientSuggest('sea')[0].sub);
await makeBilling(app, 'DW', ['A Line']);
el('sEmail').value = '';
app.openStmt();
ok('recipient auto-fills from the picked client',
   el('sEmail').value === 'ap@seaford.test', el('sEmail').value);
ok('and stays editable', !/id="sEmail"[^>]*readonly/.test(html));
ok('the send still verifies the recipient',
   /client:client,/.test(html) && /billing_email=eq\./.test(
     fs.readFileSync(FN_SRC,'utf8')));
ok('a missing address is prompted for once', /prompt\('Billing email for /.test(html));
ok('and saved back', /setBillingEmail\(client,to\)/.test(html));

console.log('\n--- D. A4 print layout ---');
const pr = html.slice(html.indexOf('@media print{'), html.indexOf('@media print{') + 2200);
// size:auto rather than a named paper, so a Letter tray is not scaled
ok('page size left to the paper', /@page\{size:auto/.test(html));
ok('a real page margin is declared', /@page\{size:auto;margin:12mm\}/.test(html),
   (html.match(/@page\{[^}]*\}/) || [''])[0]);
ok('plus a side inset that survives Margins: None',
   /\.stmt\{[^}]*padding:0 \dmm/.test(pr));
// @page reserves the margin, so the document is auto-width inside it
ok('content fills the printable width', /\.stmt\{width:auto;max-width:none/.test(pr));
ok('table header repeats across pages', /thead\{display:table-header-group\}/.test(pr));
ok('rows never split', /tbody tr\{break-inside:avoid/.test(pr));
ok('totals are not orphaned from the table', /\.stmt-tot\{[^}]*break-before:avoid/.test(pr));
ok('payment block stays whole', /\.pay[^{]*\{[^}]*break-inside:avoid/.test(pr) ||
   /\.words,\.pay,\.stmt-close[^{]*\{[^}]*break-inside:avoid/.test(pr), pr.slice(0,400));
ok('orphan and widow control', /orphans:3;widows:3/.test(pr));

console.log('\n--- E. no signature block ---');
app = reset();
app.cfg.payee = 'Rafael S. Rosales';
app.cfg.remitEmail = 'billing@rsr.test';
app.cfg.signer = 'Raffy J. Ramirez';
app.cfg.role = 'Naval Architect & Marine Engineer';
await makeBilling(app, 'DW', ['One Line']);
openStmtFor(app);
el('sNo').value = 'BILLDWG-26-001';

app.cfg.showPrepared = false;
app.renderStatement(app.pickedRows());
let doc = el('printRoot').innerHTML;
ok('no signature block in the markup', !/stmt-sig/.test(doc));
ok('no Received / conforme', !/conforme/i.test(doc));
ok('no signature-over-printed-name line', !/signature over printed name/i.test(doc));
ok('closes with a thank you', /Thank you for your business\./.test(doc));
ok('prepared-by hidden when off', !/Prepared by:/.test(doc));

app.cfg.showPrepared = true;
app.renderStatement(app.pickedRows());
doc = el('printRoot').innerHTML;
ok('prepared-by shown when on', /Prepared by: Raffy J\. Ramirez/.test(doc), doc.slice(-320));
ok('with the position appended', /Naval Architect &amp; Marine Engineer/.test(doc));
ok('still no signature block', !/stmt-sig/.test(doc));
ok('Settings has the toggle', /id="cPrepared"/.test(html));
ok('no signature-image feature anywhere',
   !/signature.?(image|upload|canvas|pad|data:image)/i.test(html));

console.log('\n--- E2. the emailed copy matches ---');
const mail = app.statementEmailHtml();
ok('email closes the same way', /Thank you for your business\./.test(mail));
ok('email has no signature block', !/stmt-sig/.test(mail));
ok('email styles the closing block', /\.stmt-close/.test(mail));

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
