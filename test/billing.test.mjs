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
KEYS.forEach(k => globalThis.localStorage.removeItem(k));

net.mode = 'offline';
const app = globalThis.__loadApp();
const YY = String(new Date().getFullYear()).slice(2);

console.log('\n--- A. billing number ---');
ok('BILLDWG-YY-NNN shape', app.nextBillNo() === `BILLDWG-${YY}-001`, app.nextBillNo());
// per-type prefixes and series are covered in billno.test.mjs
ok('prefix comes from the type', app.billPrefixOf('DW') === 'BILLDWG', app.billPrefixOf('DW'));
ok('an unissued number does not burn the series',
   app.nextBillNo() === app.nextBillNo(), app.nextBillNo());
app.commitBillNo(`BILLDWG-${YY}-001`);
ok('issuing advances the series', app.nextBillNo() === `BILLDWG-${YY}-002`, app.nextBillNo());
app.commitBillNo(`BILLDWG-${YY}-007`);
ok('an edited number is respected', app.nextBillNo() === `BILLDWG-${YY}-008`, app.nextBillNo());
app.commitBillNo(`BILLDWG-${YY}-003`);
ok('a lower number does not rewind', app.nextBillNo() === `BILLDWG-${YY}-008`, app.nextBillNo());
app.cfg.billSeries.DW = { y: String(Number(YY) - 1), n: 42 };
ok('a new calendar year restarts at 001', app.nextBillNo() === `BILLDWG-${YY}-001`, app.nextBillNo());
app.commitBillNo('not-a-number');
ok('garbage is ignored', app.nextBillNo() === `BILLDWG-${YY}-001`, app.nextBillNo());
ok('the field stays editable', !/id="sNo"[^>]*readonly/.test(html) &&
   !/id="sNo"[^>]*disabled/.test(html));

console.log('\n--- B. the document is titled BILLING ---');
app.cfg.billSeries = {};
app.cfg.company = 'RSR ENGINEERING SERVICES';
app.cfg.payee = 'Rafael S. Rosales';
app.cfg.remitEmail = 'billing@rsr.test';
app.cfg.banks = [
  { bank:'BDO',     name:'Rafael S. Rosales', acct:'1234-5678-90' },
  { bank:'Metrobank', name:'Rafael S. Rosales', acct:'0987-6543-21' },
];
await app.cliSave({ name:'Seaford Shipping Lines', contact_person:'Ms. Ana Cruz',
                    address:'Pier 4, Cebu City', billing_email:'ap@seaford.test' }, true);
app.rows.push(
  { id:'r1', code:'RSR-DW-082026-001', doc_type:'DW', bill_date:'2026-08-10',
    client:'Seaford Shipping Lines', vessel:'MV SF Voyager', drawing_no:'SE-01',
    drawing_title:'Shell Expansion Plan', qty:1, rate:30000, status:'DRAFT' },
  { id:'r2', code:'RSR-DW-082026-002', doc_type:'DW', bill_date:'2026-08-12',
    client:'Seaford Shipping Lines', vessel:'MV SF Voyager', drawing_no:'MS-01',
    drawing_title:'Midship Section', qty:1, rate:30000, status:'DRAFT' });

el('sClient').value = 'Seaford Shipping Lines';
el('sFrom').value = '2026-08-01'; el('sTo').value = '2026-08-31';
el('sTerms').value = '30'; el('sVat').value = '0';
el('sNo').value = app.nextBillNo();
app.renderStatement(app.rows.slice(0, 2));
const doc = el('printRoot').innerHTML;

ok('titled BILLING, not Statement of Account',
   /<div class="t">Billing<\/div>/.test(doc) && !/Statement of Account/.test(doc));
ok('carries the billing number', doc.includes(`BILLDWG-${YY}-001`));

console.log('\n--- C. Bill To block ---');
ok('has a Bill To block', /class="bill-to"/.test(doc));
ok('contact person printed', /Ms\. Ana Cruz/.test(doc));
ok('company printed', /Seaford Shipping Lines/.test(doc));
ok('address printed', /Pier 4, Cebu City/.test(doc));

console.log('\n--- D. numbered item list ---');
ok('items numbered 1.0 and 2.0', doc.includes('>1.0<') && doc.includes('>2.0<'));
ok('description column present', /<th[^>]*>Description<\/th>/.test(doc));
ok('titles listed', /Shell Expansion Plan/.test(doc) && /Midship Section/.test(doc));
ok('ref no. and vessel kept as a sub-line', /SE-01/.test(doc) && /MV SF Voyager/.test(doc));

console.log('\n--- E. amount in words survives ---');
ok('amount-in-words block present', /class="words"/.test(doc));
ok('reads "Sixty Thousand Pesos Only"', /Sixty Thousand Pesos Only/.test(doc),
   (doc.match(/class="words"[\s\S]{0,120}/) || [''])[0]);

console.log('\n--- F. payment details after the total ---');
ok('payment block present', /class="pay"/.test(doc));
ok('payee line', /Please issue payment to/.test(doc) && /Rafael S\. Rosales/.test(doc));
ok('first bank listed', /BDO/.test(doc) && /1234-5678-90/.test(doc));
ok('second bank listed', /Metrobank/.test(doc) && /0987-6543-21/.test(doc));
ok('deposit slip instruction with the billing email',
   /deposit slip/i.test(doc) && /billing@rsr\.test/.test(doc));
ok('payment block comes after the total',
   doc.indexOf('class="pay"') > doc.indexOf('stmt-tot'));
ok('and after the amount in words',
   doc.indexOf('class="pay"') > doc.indexOf('class="words"'));

console.log('\n--- G. the block degrades when unconfigured ---');
const saved = { p: app.cfg.payee, b: app.cfg.banks, r: app.cfg.remitEmail };
app.cfg.payee = ''; app.cfg.banks = []; app.cfg.remitEmail = '';
app.renderStatement(app.rows.slice(0, 2));
ok('no empty payment block when nothing is set',
   !/class="pay"/.test(el('printRoot').innerHTML));
Object.assign(app.cfg, { payee: saved.p, banks: saved.b, remitEmail: saved.r });

console.log('\n--- H. the emailed copy is the same layout ---');
app.renderStatement(app.rows.slice(0, 2));
const mail = app.statementEmailHtml();
ok('email carries the Bill To block', /class="bill-to"/.test(mail));
ok('email carries the payment block', /class="pay"/.test(mail));
ok('email carries the numbered items', mail.includes('>1.0<'));
ok('email styles the new blocks', /\.bill-to\s*\{/.test(mail) && /\.pay\s*\{/.test(mail));
ok('no unresolved CSS variables in the email', !/var\(--/.test(mail));

console.log('\n--- I. client records are stored, not just typed ---');
ok('clients table gains the new columns',
   /add column if not exists contact_person/.test(html) &&
   /add column if not exists address/.test(html));
const rec = app.clients.find(c => c.name === 'Seaford Shipping Lines');
ok('record round-trips', rec && rec.contact_person === 'Ms. Ana Cruz' &&
   rec.address === 'Pier 4, Cebu City', JSON.stringify(rec));
ok('queued for sync like everything else',
   app.queue.some(j => j.store === 'clients'), JSON.stringify(app.queue.map(j => j.store)));
ok('payload carries the new fields',
   JSON.stringify(app.queue.find(j => j.store === 'clients').data).includes('contact_person'));

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
