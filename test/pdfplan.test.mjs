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
// The period comes from the billings' bill_date, all 2026-08-19 here, not from
// the sheet's 01-31 Aug filter. It used to read the filter, so a single-billing
// send printed "21 Aug 2026 — 21 Aug 2026" on the client's copy.
ok('the period is formatted, not raw ISO',
   text.indexOf(app.fmtDate('2026-08-19')) > -1 && text.indexOf('2026-08-19') === -1);
ok('one day prints as one date, not a range',
   text.indexOf(app.fmtDate('2026-08-19') + ' — ' + app.fmtDate('2026-08-19')) === -1,
   text.slice(text.indexOf('Period covered'), text.indexOf('Period covered') + 60));
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
const bottomOf = o => o.t === 'line' ? Math.max(o.y1, o.y2)
  : o.t === 'rect' ? o.y + o.h : o.y;
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

console.log('\n--- 16. the wrap budget is the Description column, not the next one ---');
// The print widths are 7/53/7/16/17, so Description ends at 60%. Budgeting the
// wrap to cQty (67%, the right edge of Qty) let a wrapped line reach across the
// Qty number -- the overlap the wrap exists to prevent.
{
  const M = 42, right = pl.page.w - M, colW = right - M;
  const cDesc = M + 0.07 * colW, descEnd = M + 0.60 * colW;
  const descOps = pl.ops.filter(o => o.t === 'text' && Math.abs(o.x - cDesc) < 0.01);
  ok('there are description ops to check', descOps.length > 2, String(descOps.length));
  const over = descOps.filter(o => o.x + o.s.length * (o.size || 9) * 0.5 > descEnd + 0.5);
  ok('no description line is budgeted past the Description column',
     over.length === 0, JSON.stringify(over.map(o => o.s).slice(0, 2)));
}

console.log('\n--- 17. characters typed by a user are sanitised too ---');
{
  const curly = Object.assign({}, rows[0], { id:'C1',
    drawing_title: 'Owner’s “final” lines plan — rev B' });
  const cp = app.pdfPlan(app.stmtFacts([app.groupOf([curly])]), 'BILLDWG-26-005');
  ok('no code point above U+00FF survives from user text',
     !/[Ā-￿]/.test(JSON.stringify(cp)), JSON.stringify(cp).slice(0, 80));
  const ct = cp.ops.filter(o => o.t === 'text').map(o => o.s).join('\n');
  ok('a curly apostrophe becomes a straight one', ct.indexOf("Owner's") > -1, ct.slice(0, 60));
  ok('curly quotes become straight ones', ct.indexOf('"final"') > -1);
  ok('and nothing became a question mark', ct.indexOf('?') === -1, ct.slice(0, 120));
}

console.log('\n--- 18. the branches the fixture does not otherwise reach ---');
{
  const wh = Object.assign({}, facts, { vat:-2, adj:-110, grand:facts.sub - 110 });
  const wt = app.pdfPlan(wh, 'BILLDWG-26-006').ops
    .filter(o => o.t === 'text').map(o => o.s).join('\n');
  ok('a negative adjustment is labelled as withholding tax',
     wt.indexOf('Less: Withholding tax 2%') > -1, wt.match(/Less[^\n]*/));

  app.cfg.showPrepared = true; app.cfg.signer = 'Raffy J. Ramirez';
  app.cfg.role = 'Naval Architect';
  const withSig = app.pdfPlan(facts, 'BILLDWG-26-007').ops
    .filter(o => o.t === 'text').map(o => o.s).join('\n');
  ok('the preparer is named when Settings says to',
     withSig.indexOf('Prepared by: Raffy J. Ramirez, Naval Architect') > -1,
     withSig.match(/Prepared[^\n]*/));

  app.cfg.showPrepared = false;
  const noSig = app.pdfPlan(facts, 'BILLDWG-26-008').ops
    .filter(o => o.t === 'text').map(o => o.s).join('\n');
  ok('and left off when it does not', noSig.indexOf('Prepared by') === -1);
}

console.log('\n--- 19. the print copy’s rules and boxes ---');
// Presentation parity. The harness has no layout and no painting, so every
// assertion here is against the op list: it can prove a rect exists, in the
// right colour, at the right coordinates, in the right drawing order, and
// that none straddles a page. Whether the result LOOKS right is MANUAL-TEST
// section 9, walked by hand.
const INK = [16, 31, 46];            // --ink, from the print stylesheet
const sameRGB = (a, b) => !!a && a.length === 3 && a.every((n, i) => n === b[i]);
const rects = (pl) => pl.ops.filter(o => o.t === 'rect');
const filled = (pl) => rects(pl).filter(o => o.fill);
const stroked = (pl) => rects(pl).filter(o => !o.fill);
const opFor = (pl, s) => pl.ops.find(o => o.t === 'text' && o.s === s);
const encloses = (r, o) => (r.p || 0) === (o.p || 0) &&
  o.y >= r.y && o.y <= r.y + r.h && o.x >= r.x && o.x <= r.x + r.w;

{
  const heads = plan.ops.filter(o => o.t === 'text' && o.s === 'Amount (PHP)');
  ok('the table header sits on a filled band', filled(plan).length === heads.length &&
     filled(plan).length > 0, 'filled=' + filled(plan).length + ' heads=' + heads.length);
  ok('the band is the print copy’s #101F2E',
     filled(plan).length > 0 && filled(plan).every(o => sameRGB(o.fill, INK)),
     JSON.stringify(filled(plan).map(o => o.fill)));
  ok('every header label is enclosed by the band',
     ['No.', 'Description', 'Qty', 'Rate', 'Amount (PHP)'].every(s =>
       filled(plan).some(r => encloses(r, opFor(plan, s)))));
  ok('the band is emitted before the labels, so they land on top of it',
     filled(plan).length > 0 &&
     plan.ops.indexOf(filled(plan)[0]) < plan.ops.indexOf(opFor(plan, 'Amount (PHP)')));
  const hdrText = ['No.', 'Description', 'Qty', 'Rate', 'Amount (PHP)']
    .map(s => opFor(plan, s));
  ok('the header labels are white', hdrText.every(o => sameRGB(o.color, [255, 255, 255])),
     JSON.stringify(hdrText.map(o => o.color)));
  ok('nothing else on the page is white',
     plan.ops.filter(o => o.t === 'text' && sameRGB(o.color, [255, 255, 255]))
       .every(o => /^(No\.|Description|Qty|Rate|Amount \(PHP\))$/.test(o.s)));
}

{
  const rule = plan.ops.filter(o => o.t === 'line' && o.lw === 2);
  ok('there is one 2pt rule, the one above the totals', rule.length === 1,
     String(rule.length));
  ok('it is drawn in ink, as .stmt-tot’s border-top is',
     rule.length === 1 && sameRGB(rule[0].color, INK),
     rule.length ? JSON.stringify(rule[0].color) : '');
  const tot = opFor(plan, 'Total amount due');
  ok('it sits above the totals, on the same page',
     rule.length === 1 && (rule[0].p || 0) === (tot.p || 0) && rule[0].y1 < tot.y);
  ok('every other rule keeps its hairline weight',
     plan.ops.filter(o => o.t === 'line' && o.lw !== undefined && o.lw !== 2).length === 0);
}

{
  // Bill to, vessel, meta, amount in words, payment details
  ok('five stroked boxes', stroked(plan).length === 5,
     JSON.stringify(stroked(plan).map(o => [o.y, o.h])));
  const boxOf = (s) => stroked(plan).find(r => encloses(r, opFor(plan, s)));
  ['Bill to', 'Vessel name', 'Period covered', 'Amount in words', 'Payment details']
    .forEach(s => ok('a box around ' + s, !!boxOf(s)));
  const bt = boxOf('Bill to');
  ok('the Bill to box holds the whole block, not just its label',
     !!bt && encloses(bt, opFor(plan, 'Mr. Ashford Chua')) &&
     encloses(bt, opFor(plan, 'Seaford Shipping Lines')) &&
     encloses(bt, opFor(plan, 'Makati City, Philippines')));
  ok('the boxes are outset from the text, never inset into it',
     stroked(plan).every(r => r.x < 42 && r.x + r.w > plan.page.w - 42));
  ok('all five share one pair of outer edges, and the band shares it too',
     rects(plan).every(r => Math.abs(r.x - rects(plan)[0].x) < 0.01 &&
                            Math.abs(r.w - rects(plan)[0].w) < 0.01),
     JSON.stringify(rects(plan).map(r => [r.x, r.w])));
  ok('each box is emitted after the text it surrounds, so a stroke cannot cover it',
     stroked(plan).every(r => plan.ops.filter(o => o.t === 'text' && encloses(r, o))
       .every(o => plan.ops.indexOf(o) < plan.ops.indexOf(r))));
  ok('the boxes do not overlap each other',
     stroked(plan).every((a, i) => stroked(plan).every((b, j) =>
       i === j || (a.p || 0) !== (b.p || 0) ||
       a.y + a.h <= b.y + 0.01 || b.y + b.h <= a.y + 0.01)));
}

{
  // the meta box carries two internal dividers, one per cell boundary
  const meta = stroked(plan).find(r => encloses(r, opFor(plan, 'Period covered')));
  const vert = plan.ops.filter(o => o.t === 'line' && Math.abs(o.x1 - o.x2) < 0.01);
  ok('two vertical rules, and only two', vert.length === 2, String(vert.length));
  ok('both run the full height of the meta box', !!meta && vert.every(o =>
     (o.p || 0) === (meta.p || 0) && Math.abs(Math.min(o.y1, o.y2) - meta.y) < 0.01 &&
     Math.abs(Math.max(o.y1, o.y2) - (meta.y + meta.h)) < 0.01),
     JSON.stringify(vert.map(o => [o.y1, o.y2])) +
     ' box=' + JSON.stringify([meta && meta.y, meta && meta.h]));
  ok('both sit inside the box, not on its edges',
     !!meta && vert.every(o => o.x1 > meta.x + 1 && o.x1 < meta.x + meta.w - 1));
  // 1.35 / 1 / 1 of the inner width, as .stmt-meta>div.wide sets it
  const want = !meta ? [] : [1.35, 2.35].map(k => meta.x + meta.w * k / 3.35);
  ok('at the flex boundaries print divides the row on',
     vert.length === 2 && vert.map(o => o.x1).sort((a, b) => a - b)
       .every((x, i) => Math.abs(x - want[i]) < 0.5),
     JSON.stringify(vert.map(o => o.x1)) + ' want ' + JSON.stringify(want));
  // and the cell text must clear its own divider, or the label prints on it
  ['Terms', 'Due on'].forEach(s => ok(s + ' clears the divider to its left',
     vert.some(o => opFor(plan, s).x - o.x1 > 4 && opFor(plan, s).x - o.x1 < 20),
     String(opFor(plan, s).x)));
}

{
  // the property a human eye would catch late and a test can catch now
  const straddles = (pl) => rects(pl).filter(r =>
    r.y < 0 || r.y + r.h > pl.page.bottom + 0.01 ||
    r.x < 0 || r.x + r.w > pl.page.w + 0.01);
  ok('no rect straddles a page in the base plan',
     straddles(plan).length === 0, JSON.stringify(straddles(plan)));
  ok('nor in the forty-line plan', straddles(p40).length === 0,
     JSON.stringify(straddles(p40)));
  const hdrRects = filled(p40).length;
  const p40heads = p40.ops.filter(o => o.t === 'text' && o.s === 'Amount (PHP)').length;
  ok('the band follows the header onto every continuation page',
     hdrRects === p40heads && hdrRects > 1, 'rects=' + hdrRects + ' heads=' + p40heads);

  // the boxed blocks are pushed down the page a line at a time, so every
  // boundary case is walked rather than one lucky fixture
  let bad = 0, worstPages = 0;
  for (let n = 1; n <= 55; n++) {
    const tall = Object.assign({}, app.clients[0], { id:'c'+n,
      address: Array.from({ length:n }, (_, i) => 'Address line ' + (i+1)).join('\n') });
    const pn = app.pdfPlan(Object.assign({}, facts, { rec: tall }), 'BILLDWG-26-009');
    worstPages = Math.max(worstPages,
      Math.max.apply(null, pn.ops.map(o => o.p || 0)) + 1);
    if (straddles(pn).length) {
      bad++;
      if (bad === 1) console.log('    first bad n=' + n + ' ' +
        JSON.stringify(straddles(pn)));
    }
  }
  ok('no rect straddles a page at any block height', bad === 0, bad + ' of 55');
  ok('and the sweep really does paginate', worstPages > 1, String(worstPages));
}

{
  // the boxes are per-block, not decoration: drop a block and its box goes
  const noVes = app.pdfPlan(Object.assign({}, facts, { oneVessel:'' }), 'BILLDWG-26-010');
  ok('no vessel, no vessel box', stroked(noVes).length === 4,
     String(stroked(noVes).length));
  const keep2 = { payee:app.cfg.payee, remitEmail:app.cfg.remitEmail, banks:app.cfg.banks };
  Object.assign(app.cfg, { payee:'', remitEmail:'', banks:[] });
  const noPay = app.pdfPlan(facts, 'BILLDWG-26-011');
  ok('no payment details, no payment box', stroked(noPay).length === 4,
     String(stroked(noPay).length));
  Object.assign(app.cfg, keep2);
}

console.log('\n--- 20. pdfDoc plays the plan back without leaking state ---');
{
  // Colour and line width are document state in jsPDF, not per-call arguments:
  // whatever an op sets stays set. A missed reset would not fail loudly, it
  // would quietly paint the rest of the billing white - so the plan is played
  // through a recording double and every drawing call is checked against the
  // op that asked for it.
  const log = [];
  let fill = [0,0,0], drawC = [0,0,0], txtC = [0,0,0], lw = 0.6, pageN = 0;
  globalThis.window.jspdf = { jsPDF: class {
    setFont(){} setFontSize(){}
    setLineWidth(n){ lw = n; }
    setFillColor(r, g, b){ fill = [r, g, b]; }
    setDrawColor(r, g, b){ drawC = [r, g, b]; }
    setTextColor(r, g, b){ txtC = [r, g, b]; }
    addPage(){ pageN++; }
    snap(k){ log.push({ k, fill:fill.slice(), draw:drawC.slice(),
                        txt:txtC.slice(), lw, p:pageN }); }
    text(){ this.snap('text'); }
    line(){ this.snap('line'); }
    rect(x, y, w, h, mode){ this.snap(mode === 'F' ? 'fill' : 'stroke'); }
    addImage(){ this.snap('image'); }
  } };
  await app.pdfDoc(p40);
  const kindOf = o => o.t === 'rect' ? (o.fill ? 'fill' : 'stroke') : o.t;
  const wantFill = o => (o.t === 'rect' && o.fill) ? o.fill : [0, 0, 0];
  const wantDraw = o => (o.t === 'line' && o.color) ? o.color : [0, 0, 0];
  const wantTxt = o => o.t === 'text' && o.color ? o.color : [0, 0, 0];
  const off = (f) => log.map((r, i) => [i, r, p40.ops[i]]).filter(a => !f(a[1], a[2]));
  ok('every op is drawn, once, in order',
     log.length === p40.ops.length && log.every((r, i) => r.k === kindOf(p40.ops[i])),
     log.length + ' vs ' + p40.ops.length);
  ok('each op is drawn on the page it names',
     log.every((r, i) => r.p === (p40.ops[i].p || 0)));
  const fillOK = (r, o) => r.fill.join() === wantFill(o).join();
  ok('a filled rect gets the fill the plan asked for, and nothing else inherits it',
     off(fillOK).length === 0, JSON.stringify(off(fillOK).slice(0, 2)));
  const txtOK = (r, o) => r.txt.join() === wantTxt(o).join();
  ok('a white label is white when it is drawn, and black is restored after it',
     off(txtOK).length === 0, JSON.stringify(off(txtOK).slice(0, 2)));
  const drawOK = (r, o) => r.draw.join() === wantDraw(o).join();
  ok('the stroke colour is the op’s, and never outlives it',
     off(drawOK).length === 0, JSON.stringify(off(drawOK).slice(0, 2)));
  const lwOK = (r, o) => r.lw === (o.lw || 0.6);
  ok('line width follows the op, then returns to a hairline',
     off(lwOK).length === 0, JSON.stringify(off(lwOK).slice(0, 2)));
  delete globalThis.window.jspdf;
}

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
