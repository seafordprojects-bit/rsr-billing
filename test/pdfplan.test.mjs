// The attached PDF is the printed document. Every assertion here is written
// against what renderStatement puts on the page, so the two cannot drift.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.argv[2] = process.argv[2] || path.join(ROOT, 'index.html');
import { net } from './harness.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra='') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const textOf = (plan) => plan.ops.filter(o => o.t === 'text').map(o => o.s).join('\n');
const pageText = (plan, p) => plan.ops
  .filter(o => o.t === 'text' && (o.p || 0) === p).map(o => o.s).join('\n');
const el = id => globalThis.document.getElementById(id);

const app = globalThis.__loadApp();
const rows = [
  { id:'r1', line_no:1, group_id:'g1', code:'RSR-DW-082026-001', bill_no:'BILLDWG-26-001',
    client:'Seaford Shipping Lines', vessel:'MV SF Voyager', drawing_no:'D-101',
    drawing_title:'Shell Expansion Plan', qty:2, rate:1500, status:'DRAFT',
    bill_date:'2026-08-19' },
  { id:'r2', line_no:2, group_id:'g1', code:'RSR-DW-082026-001', bill_no:'BILLDWG-26-001',
    client:'Seaford Shipping Lines', vessel:'MV SF Voyager', drawing_no:'D-102',
    drawing_title:'Midship Section', qty:1, rate:2500, status:'DRAFT',
    bill_date:'2026-08-19' },
  // a delivered-but-not-charged line: print puts "No Charge" in BOTH cells
  { id:'r3', line_no:3, group_id:'g1', code:'RSR-DW-082026-001', bill_no:'BILLDWG-26-001',
    client:'Seaford Shipping Lines', vessel:'MV SF Voyager', drawing_no:'D-103',
    drawing_title:'Capacity Plan', qty:2, rate:999, billable:false, status:'DRAFT',
    bill_date:'2026-08-19' },
];
app.rows.push.apply(app.rows, rows);
app.clients.push({ id:'c1', name:'Seaford Shipping Lines', salutation:'Mr. Chua',
                   contact_person:'Mr. Ashford Chua',
                   address:'12F Ayala Tower One\nMakati City, Philippines',
                   billing_email:'ap@seaford.test' });

Object.assign(app.cfg, {
  company:'RSR ENGINEERING SERVICES',
  address:'Carmen & Mandaue Yard Facilities\nCebu, Philippines',
  contact:'rsr@example.test', contactNo:'+63 900 000 0000',
  payee:'Rafael S. Ramirez', remitEmail:'billing@rsr.test',
  banks:[{ bank:'BDO', name:'Rafael S. Ramirez', acct:'0012-3456-7890' },
         { bank:'', name:'', acct:'' }],
  showPrepared:true, signer:'Raffy J. Ramirez', role:'Naval Architect',
});

app.openStmt();
el('sClient').value = 'Seaford Shipping Lines';
el('sVat').value = '12';
el('sTerms').value = '30';
el('sFrom').value = '2026-08-01';
el('sTo').value = '2026-08-31';

const facts = app.stmtFacts([app.groupOf(rows)]);
const plan = app.pdfPlan(facts, 'BILLDWG-26-001');
const text = textOf(plan);

console.log('\n--- 1. the page is A4, and it declares its own bottom ---');
ok('width 595pt', Math.round(plan.page.w) === 595, String(plan.page.w));
ok('height 842pt', Math.round(plan.page.h) === 842, String(plan.page.h));
ok('the plan states the bottom margin', typeof plan.page.bottom === 'number' &&
   plan.page.bottom > 0 && plan.page.bottom < plan.page.h, String(plan.page.bottom));

console.log('\n--- 2. the filename is the billing number ---');
ok('filename', plan.filename === 'BILLDWG-26-001.pdf', plan.filename);
ok('no tracking code in the filename', plan.filename.indexOf('RSR-') === -1);

console.log('\n--- 3. no tracking code reaches the client copy ---');
ok('no RSR- string anywhere in the plan',
   JSON.stringify(plan).indexOf('RSR-') === -1);

console.log('\n--- 4. nothing jsPDF cannot encode ---');
// jsPDF's standard Helvetica is cp1252. One code point above U+00FF makes it
// re-encode the whole string as UTF-16 and the reader shows a NUL before
// every character - which is how the peso sign corrupted every amount.
const high = text.match(/[Ā-￿]/g);
ok('no code point above U+00FF anywhere in the plan', !high, JSON.stringify(high));
ok('no peso sign', text.indexOf('₱') === -1);
ok('pdfMoney strips the sign', app.pdfMoney(6160) === app.money(6160).slice(1),
   app.pdfMoney(6160));
ok('the currency is carried by the column head', text.indexOf('Amount (PHP)') > -1);
ok('and by a note above the amount in words',
   text.indexOf('All amounts in Philippine Pesos (PHP)') > -1);

console.log('\n--- 5. every money value comes from stmtFacts ---');
ok('subtotal is facts.sub', text.indexOf(app.pdfMoney(facts.sub)) > -1,
   app.pdfMoney(facts.sub));
ok('adjustment is facts.adj', text.indexOf(app.pdfMoney(facts.adj)) > -1,
   app.pdfMoney(facts.adj));
ok('grand total is facts.grand', text.indexOf(app.pdfMoney(facts.grand)) > -1,
   app.pdfMoney(facts.grand));
// pesoWords, not words: words(grand) is a PREFIX of pesoWords(grand), so an
// assertion on words() passes even when the PDF is missing "Pesos ... Only"
ok('amount in words is pesoWords(facts.grand)',
   text.indexOf(app.pesoWords(facts.grand)) > -1, app.pesoWords(facts.grand));
ok('line 1 amount is amountOf(row)',
   text.indexOf(app.pdfMoney(app.amountOf(rows[0]))) > -1);
ok('line 2 amount is amountOf(row)',
   text.indexOf(app.pdfMoney(app.amountOf(rows[1]))) > -1);
ok('every line title appears', rows.every(r => text.indexOf(r.drawing_title) > -1));
ok('the billing number appears', text.indexOf('BILLDWG-26-001') > -1);
ok('the client appears', text.indexOf('Seaford Shipping Lines') > -1);
ok('the vessel appears', text.indexOf('MV SF Voyager') > -1);

console.log('\n--- 6. the plan reads facts, it does not recompute ---');
// the mutation proof: a plan reading the DOM would not follow this
const bumped = Object.assign({}, facts, { vat:0, adj:0, grand:facts.sub });
const plan2 = app.pdfPlan(bumped, 'BILLDWG-26-001');
const text2 = textOf(plan2);
ok('the total follows the facts it was given',
   text2.indexOf(app.pdfMoney(facts.sub)) > -1 &&
   text2.indexOf(app.pdfMoney(facts.grand)) === -1,
   app.pdfMoney(facts.sub) + ' vs ' + app.pdfMoney(facts.grand));
ok('the words follow too', text2.indexOf(app.pesoWords(facts.sub)) > -1);

console.log('\n--- 7. the header block is renderStatement’s ---');
ok('the company name, in the printed casing', text.indexOf('RSR ENGINEERING SERVICES') > -1);
ok('the address, line by line',
   text.indexOf('Carmen & Mandaue Yard Facilities') > -1 &&
   text.indexOf('Cebu, Philippines') > -1);
ok('the contact', text.indexOf('rsr@example.test') > -1);
ok('the contact number, labelled as print labels it',
   text.indexOf('contact no.: +63 900 000 0000') > -1);
ok('no invented tagline', text.indexOf('Naval Architecture ·') === -1 &&
   text.indexOf('Drydocking') === -1);
ok('the word Billing, as print heads it', /(^|\n)Billing($|\n)/.test(text));
ok('the mark is drawn', plan.ops.some(o => o.t === 'image' && o.d === app.MARK_INK));
ok('the billing carries today’s date, formatted',
   text.indexOf(app.fmtDate(app.today())) > -1, app.fmtDate(app.today()));

console.log('\n--- 8. Bill to, vessel and the meta row ---');
ok('the Bill to label', text.indexOf('Bill to') > -1);
ok('the contact person', text.indexOf('Mr. Ashford Chua') > -1);
ok('the contact person comes before the client name, as in print',
   text.indexOf('Mr. Ashford Chua') < text.indexOf('Seaford Shipping Lines'));
ok('the salutation never reaches the client copy', !/^Mr\. Chua$/m.test(text));
ok('the address, line by line',
   text.indexOf('12F Ayala Tower One') > -1 && text.indexOf('Makati City, Philippines') > -1);
ok('the vessel is labelled as print labels it', text.indexOf('Vessel name') > -1);
ok('Period covered', text.indexOf('Period covered') > -1);
ok('the period is formatted, not raw ISO',
   text.indexOf(app.fmtDate('2026-08-01')) > -1 && text.indexOf('2026-08-01') === -1);
ok('Terms, in days', text.indexOf('30 days') > -1);
ok('Due on', text.indexOf('Due on') > -1);
ok('the due date is formatted, not raw ISO',
   text.indexOf(app.fmtDate(facts.due)) > -1 && text.indexOf(facts.due) === -1,
   facts.due);

console.log('\n--- 9. the table ---');
['No.', 'Description', 'Qty', 'Rate', 'Amount (PHP)'].forEach(h =>
  ok('column ' + h, text.indexOf(h) > -1));
ok('lines are numbered 1.0, 2.0, 3.0',
   text.indexOf('1.0') > -1 && text.indexOf('2.0') > -1 && text.indexOf('3.0') > -1);
ok('the drawing number rides under the title', text.indexOf('D-101') > -1);
ok('one vessel stays out of the lines',
   plan.ops.filter(o => o.t === 'text' && o.s === 'MV SF Voyager').length === 1);
// two vessels: print puts the vessel back on the line, because that is the
// only place it can stay unambiguous
const two = rows.slice(0, 2).map((r, i) => Object.assign({}, r,
  { id:'v'+i, vessel: i ? 'MV SF Trader' : 'MV SF Voyager' }));
const textTwo = textOf(app.pdfPlan(app.stmtFacts([app.groupOf(two)]), 'BILLDWG-26-002'));
ok('two vessels go back onto the lines',
   textTwo.indexOf(app.pdfText('MV SF Trader · D-102')) > -1, textTwo);

console.log('\n--- 10. a no-charge line ---');
const ncOps = plan.ops.filter(o => o.t === 'text' && o.s === 'No Charge');
ok('No Charge appears twice - rate AND amount, as print does',
   ncOps.length === 2, JSON.stringify(ncOps.map(o => o.x)));
ok('the no-charge line’s real rate is nowhere on the document',
   text.indexOf(app.pdfMoney(999)) === -1, app.pdfMoney(999));

console.log('\n--- 11. totals, words and the closing ---');
ok('the subtotal label counts items as print does',
   text.indexOf(app.pdfText('Subtotal — 3 items, 1 at no charge')) > -1, text);
ok('the adjustment is labelled as print labels it', text.indexOf('Add: VAT 12%') > -1);
ok('the total reads Total amount due', text.indexOf('Total amount due') > -1);
ok('the amount in words is labelled', text.indexOf('Amount in words') > -1);
ok('the closing line', text.indexOf('Thank you for your business.') > -1);
ok('Prepared by, with the role',
   text.indexOf('Prepared by: Raffy J. Ramirez, Naval Architect') > -1);

console.log('\n--- 12. the payment block mirrors payBlock() ---');
ok('the label', text.indexOf('Payment details') > -1);
ok('the payee sentence', text.indexOf('Please issue payment to Rafael S. Ramirez') > -1);
ok('the bank row', text.indexOf('BDO') > -1 && text.indexOf('0012-3456-7890') > -1);
ok('an empty bank row is dropped, as payBlock drops it',
   plan.ops.filter(o => o.t === 'text' && o.s === '').length === 0);
ok('the deposit-slip sentence',
   text.indexOf('Kindly email a copy of the deposit slip to') > -1 &&
   text.indexOf('for confirmation of payment.') > -1);
const keep = { payee:app.cfg.payee, remitEmail:app.cfg.remitEmail, banks:app.cfg.banks };
Object.assign(app.cfg, { payee:'', remitEmail:'', banks:[] });
const bare = textOf(app.pdfPlan(facts, 'BILLDWG-26-001'));
ok('the whole block is omitted when there is nothing to say',
   bare.indexOf('Payment details') === -1);
ok('the closing survives without it', bare.indexOf('Thank you for your business.') > -1);
Object.assign(app.cfg, keep);

console.log('\n--- 13. pagination is measured, not assumed ---');
const many = [];
for (let i = 0; i < 40; i++) many.push({
  id:'m'+i, line_no:i+1, group_id:'g2', code:'RSR-DW-082026-002',
  bill_no:'BILLDWG-26-003', client:'Seaford Shipping Lines', vessel:'MV SF Voyager',
  drawing_no:'D-2'+String(i).padStart(2,'0'), drawing_title:'General Arrangement sheet '+(i+1),
  qty:1, rate:1200, status:'DRAFT', bill_date:'2026-08-19' });
const f40 = app.stmtFacts([app.groupOf(many)]);
const p40 = app.pdfPlan(f40, 'BILLDWG-26-003');
const pages = Math.max.apply(null, p40.ops.map(o => o.p || 0)) + 1;
ok('forty lines do not fit on one page', pages > 1, 'pages=' + pages);
// the real measurement: the largest y any content op actually emits
const bottomOf = o => o.t === 'line' ? Math.max(o.y1, o.y2) : o.y;
const maxY = p40.ops.filter(o => !o.foot).reduce((m, o) => Math.max(m, bottomOf(o)), 0);
ok('nothing is drawn past the bottom margin', maxY <= p40.page.bottom,
   'maxY=' + maxY + ' bottom=' + p40.page.bottom);
const footY = p40.ops.filter(o => o.foot).reduce((m, o) => Math.max(m, bottomOf(o)), 0);
ok('the footer stays inside the page', footY <= p40.page.h - p40.page.m,
   'footY=' + footY);
ok('every op carries a page index',
   p40.ops.every(o => typeof o.p === 'number' && o.p >= 0 && o.p < pages));
ok('ops are ordered by page so pdfDoc can play them straight through',
   p40.ops.every((o, i) => i === 0 || o.p >= p40.ops[i-1].p));
const last = pages - 1;
ok('the total survives to the last page', pageText(p40, last).indexOf('Total amount due') > -1);
ok('the amount in words survives with it',
   pageText(p40, last).indexOf(app.pesoWords(f40.grand)) > -1);
ok('so do the payment details', pageText(p40, last).indexOf('Payment details') > -1);
for (let p = 0; p < pages; p++)
  ok('page ' + (p+1) + ' carries its footer',
     pageText(p40, p).indexOf('Page ' + (p+1) + ' of ' + pages) > -1);
ok('the footer carries the billing number, never the tracking code',
   p40.ops.filter(o => o.foot && o.s === 'BILLDWG-26-003').length === pages);
const rowPages = new Set(p40.ops
  .filter(o => o.t === 'text' && /^\d+\.0$/.test(o.s)).map(o => o.p));
const heads = p40.ops.filter(o => o.t === 'text' && o.s === 'Amount (PHP)');
ok('the table header is redrawn on every page that continues the table',
   heads.length === rowPages.size && heads.length > 1,
   'heads=' + heads.length + ' rowPages=' + rowPages.size);
ok('and on no page that does not', heads.every(o => rowPages.has(o.p)));
ok('every line of the forty appears',
   many.every(r => textOf(p40).indexOf(r.drawing_title) > -1));

console.log('\n--- 14. long text wraps rather than running into the next column ---');
const longRow = Object.assign({}, rows[0], { id:'L1', drawing_title:
  'Shell Expansion Plan including plating thickness schedule, weld details and '+
  'the complete list of scantlings for the forward and aft peak tanks' });
const pl = app.pdfPlan(app.stmtFacts([app.groupOf([longRow])]), 'BILLDWG-26-004');
ok('a long title becomes more than one drawn line',
   pl.ops.filter(o => o.t === 'text' && /Shell Expansion|scantlings|plating/.test(o.s)).length > 1);

console.log('\n--- 15. Download PDF must not burn a billing number ---');
// Print confirms a multi-billing document before it claims anything, because
// each billing gets a number of its own. Download PDF skipped that check and
// claimed first, so a CDN that would not answer spent numbers on a file that
// never existed. Order now: confirm, load, claim, build.
const a2 = globalThis.__loadApp();
a2.rows.push.apply(a2.rows, [
  { id:'q1', line_no:1, group_id:'q1', code:'RSR-DW-082026-011', doc_type:'DW',
    client:'Acme Lines', vessel:'MV One', drawing_no:'D-1', drawing_title:'Lines Plan',
    qty:1, rate:1000, status:'DRAFT', bill_date:'2026-08-10' },
  { id:'q2', line_no:1, group_id:'q2', code:'RSR-DW-082026-012', doc_type:'DW',
    client:'Acme Lines', vessel:'MV Two', drawing_no:'D-2', drawing_title:'Midship Section',
    qty:1, rate:1000, status:'DRAFT', bill_date:'2026-08-11' },
]);
a2.openStmt();
el('sClient').value = 'Acme Lines';
el('sFrom').value = '2026-08-01'; el('sTo').value = '2026-08-31';
el('sType').value = ''; el('sTerms').value = '7'; el('sVat').value = '0';
a2.buildPick();
ok('two separate billings are picked', a2.pickedRows().length === 2,
   String(a2.pickedRows().length));

let asked = 0, loads = 0;
globalThis.confirm = () => { asked++; return false; };
delete globalThis.window.jspdf;
// loadJsPdf appends a <script>; the stub's appendChild is a no-op, so this is
// the seam that lets a load actually fail instead of hanging forever.
globalThis.document.head.appendChild = (node) => { loads++; if (node.onerror) node.onerror(); };
await el('sPdf').onclick();
ok('the multi-billing question is asked, as Print asks it', asked === 1, String(asked));
ok('declining claims no number', a2.rows.every(r => !r.bill_no));
ok('and never reaches the PDF library at all', loads === 0, String(loads));

globalThis.confirm = () => true;
await el('sPdf').onclick();
ok('the library is loaded before anything is claimed', loads === 1, String(loads));
ok('a library that will not load costs no billing number',
   a2.rows.every(r => !r.bill_no), JSON.stringify(a2.rows.map(r => r.bill_no)));

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
