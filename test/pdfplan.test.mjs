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
];
app.rows.push.apply(app.rows, rows);
app.openStmt();
globalThis.document.getElementById('sClient').value = 'Seaford Shipping Lines';
globalThis.document.getElementById('sVat').value = '12';
globalThis.document.getElementById('sTerms').value = '30';

const facts = app.stmtFacts([app.groupOf(rows)]);
const plan = app.pdfPlan(facts, 'BILLDWG-26-001');
const text = textOf(plan);

console.log('\n--- 1. the page is A4 ---');
ok('width 595pt', Math.round(plan.page.w) === 595, String(plan.page.w));
ok('height 842pt', Math.round(plan.page.h) === 842, String(plan.page.h));

console.log('\n--- 2. the filename is the billing number ---');
ok('filename', plan.filename === 'BILLDWG-26-001.pdf', plan.filename);
ok('no tracking code in the filename', plan.filename.indexOf('RSR-') === -1);

console.log('\n--- 3. no tracking code reaches the client copy ---');
ok('no RSR- string anywhere in the plan',
   JSON.stringify(plan).indexOf('RSR-') === -1);

console.log('\n--- 4. every money value comes from stmtFacts ---');
ok('subtotal is facts.sub', text.indexOf(app.money(facts.sub)) > -1, app.money(facts.sub));
ok('adjustment is facts.adj', text.indexOf(app.money(facts.adj)) > -1, app.money(facts.adj));
ok('grand total is facts.grand', text.indexOf(app.money(facts.grand)) > -1,
   app.money(facts.grand));
// pesoWords, not words: words(grand) is a PREFIX of pesoWords(grand), so an
// assertion on words() passes even when the PDF is missing "Pesos ... Only"
ok('amount in words is pesoWords(facts.grand)',
   text.indexOf(app.pesoWords(facts.grand)) > -1, app.pesoWords(facts.grand));
ok('line 1 amount is amountOf(row)',
   text.indexOf(app.money(app.amountOf(rows[0]))) > -1);
ok('line 2 amount is amountOf(row)',
   text.indexOf(app.money(app.amountOf(rows[1]))) > -1);
ok('every line title appears', rows.every(r => text.indexOf(r.drawing_title) > -1));
ok('the billing number appears', text.indexOf('BILLDWG-26-001') > -1);
ok('the client appears', text.indexOf('Seaford Shipping Lines') > -1);
ok('the vessel appears', text.indexOf('MV SF Voyager') > -1);

console.log('\n--- 5. the plan reads facts, it does not recompute ---');
// the mutation proof: a plan reading the DOM would not follow this
const bumped = Object.assign({}, facts, { vat:0, adj:0, grand:facts.sub });
const plan2 = app.pdfPlan(bumped, 'BILLDWG-26-001');
const text2 = textOf(plan2);
ok('the total follows the facts it was given',
   text2.indexOf(app.money(facts.sub)) > -1 &&
   text2.indexOf(app.money(facts.grand)) === -1,
   app.money(facts.sub) + ' vs ' + app.money(facts.grand));
ok('the words follow too', text2.indexOf(app.pesoWords(facts.sub)) > -1);

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
