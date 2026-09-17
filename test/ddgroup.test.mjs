// ddgroup — a drydocking job whose documents are GROUPED must print the same
// structure on the bill as the client's transmittal cover prints:
//
//     8    Crack Testing Evidence          (charged)
//          8.1  Propeller Crack Testing…   (no charge)
//
// Reported 2026-09-17: the cover grouped and the statement printed 9.0 and
// 10.0, because the signal was a flat list with nothing saying the second
// line belonged to the first. The relationship travels as the child's parent
// TITLE (titles are already the key billing prices a line by), the RPC stores
// it in drawing_billing.parent_title, and ONE helper numbers every renderer.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || path.join(ROOT, 'index.html');
import './harness.mjs';
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const html = fs.readFileSync(SRC, 'utf8');
const KEYS = ['rsr_dwg_cfg_v1', 'rsr_dwg_rows_v1', 'rsr_dwg_queue_v1', 'rsr_dwg_session_v1',
              'rsr_dwg_catalog_v1', 'rsr_dwg_clients_v1', 'rsr_dwg_shared_v1'];
KEYS.forEach(k => globalThis.localStorage.removeItem(k));
globalThis.localStorage.setItem('rsr_dwg_cfg_v1', JSON.stringify({ seededDW: true }));
const app = globalThis.__loadApp();

console.log('\n--- 1. the numbering helper ---');
const L = app.billLabels;
ok('billLabels is reachable', typeof L === 'function');

const grouped = [
  { drawing_title: 'Transmittal' },
  { drawing_title: 'Crack Testing Evidence' },
  { drawing_title: 'Propeller Crack Testing Evidence', parent_title: 'Crack Testing Evidence' },
  { drawing_title: 'Tailshaft Crack Testing Evidence', parent_title: 'Crack Testing Evidence' },
  { drawing_title: 'Before and After Photos' },
];
ok('a parent numbers whole and its children take its number with .1 and .2, and the line after carries on from the PARENT',
   L(grouped).join('|') === '1.0|2.0|2.1|2.2|3.0', JSON.stringify(L(grouped)));

ok('a flat job -- every job sent before the drydocking side grouped anything -- numbers exactly as it always did',
   L([{ drawing_title: 'A' }, { drawing_title: 'B' }, { drawing_title: 'C' }]).join('|') === '1.0|2.0|3.0');

/* An ORPHAN is the case that decides whether this is safe to live with: a
   parent retitled in billing, or deleted, leaves a child naming something
   that is not above it. It numbers as an ordinary whole line -- degrading to
   the old flat bill -- rather than attaching itself to whatever happens to
   precede it. */
ok('a child whose parent is not the line above it numbers as a whole line, never bound to the wrong parent',
   L([{ drawing_title: 'A' }, { drawing_title: 'B', parent_title: 'Not Here' }]).join('|') === '1.0|2.0');
ok('and a child that follows a DIFFERENT parent is not adopted by it',
   L([{ drawing_title: 'P1' }, { drawing_title: 'P2' },
      { drawing_title: 'C', parent_title: 'P1' }]).join('|') === '1.0|2.0|3.0');

console.log('\n--- 2. ONE helper, every renderer ---');
/* The card, the printed statement and the PDF each wrote their own
   `${i+1}.0` before this. A PDF and a screen that disagree about a client's
   bill is worse than both printing flat, so the three read one function. */
const callsOf = (s) => (s.match(/billLabels\(/g) || []).length;
ok('billLabels is defined once and called by three renderers (card, statement, PDF)',
   (html.match(/function billLabels\(/g) || []).length === 1 && callsOf(html) === 4,
   'defs ' + ((html.match(/function billLabels\(/g) || []).length) + ', calls ' + callsOf(html));
/* CODE only: the comment above billLabels QUOTES the old expression to say
   what it replaced, and a check that reads prose would fail on the
   explanation. */
const code = html.replace(/\/\*[\s\S]*?\*\//g, '');
ok('no renderer still numbers from its own array index',
   !/\$\{i\+1\}\.0/.test(code) && !/\(i\+1\)\+'\.0'/.test(code),
   (code.match(/.{40}\$\{i\+1\}\.0.{20}/) || [''])[0]);

console.log('\n--- 3. the column travels: ingress, RPC, and what the app selects ---');
const fn = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'receive-drydock-job', 'index.ts'), 'utf8');
ok('the ingress carries parent through -- it rebuilds the payload from scratch, so a field it does not name is dropped in silence',
   /parent: string \| null/.test(fn) && /cleanText\(o\.parent, 200\)/.test(fn) &&
   /documents\.push\(\{ title, pages, billable, parent \}\)/.test(fn));
ok('the RPC stores it, and an absent parent stores NULL rather than an empty string',
   /parent_title\)/.test(html) && /nullif\(btrim\(coalesce\(v_doc->>'parent', ''\)\), ''\)/.test(html));
ok('the column is created by the generated SQL, guarded like every other',
   /alter table drawing_billing add column if not exists parent_title text;/.test(html));
ok('and the app SELECTS it, or the renderers would never see it',
   /'billable','parent_title'/.test(html));

console.log('\n--- 4. the child row on paper and on the PDF ---');
/* Found on paper (BILLDC-26-001, 2026-09-18): the 9.1 row printed 53px wide
   with its title wrapped onto four lines in 9px mono and its rule stopped
   short, while the tests above were green. The row class was `sub`, which is
   also the drawing-number SPAN's class, so the span rule's display:block
   pulled the row out of the table grid. Nothing here measures layout -- the
   harness has no layout engine -- so the guard is on the two things that
   made it possible: the row's class must not be styled by any rule written
   for something else, and the element-typed selectors must stay. */
const el = id => globalThis.document.getElementById(id);
{
  const GID = 'dd-child';
  const T = [['Certificate of Drydocking', true, null], ['Crack Testing Evidence', true, null],
             ['Propeller Crack Testing Evidence', false, 'Crack Testing Evidence'],
             ['Tailshaft Crack Testing Evidence With Many More Words Appended So That This Title Must Wrap Onto A Second Line', false, 'Crack Testing Evidence'],
             ['Docking Plan', true, null]];
  const rows = T.map((x, i) => ({ id: 'srv-c' + i, group_id: GID, line_no: i + 1, code: 'RSR-DC-092026-009', doc_type: 'DC',
    bill_date: '2026-09-17', client: 'Child Test Co.', vessel: 'MV CHILD', drawing_no: null, drawing_title: x[0], qty: 1,
    rate: 2500, status: 'DRAFT', billable: x[1], parent_title: x[2], created_at: '2026-09-17T02:41:00Z' }));
  app.rows.push(...rows);
  app.clients.push({ id: 'cc1', name: 'Child Test Co.', address: 'Somewhere', billing_email: 'x@y.test' });
  app.openStmtFor(GID);
  el('sVat').value = '0'; el('sTerms').value = '30'; el('sFrom').value = '2026-09-01'; el('sTo').value = '2026-09-30';
  app.renderStatement(app.pickedRows());
  const doc = el('printRoot').innerHTML;
  const rowsHtml = doc.match(/<tr[^>]*>[\s\S]*?<\/tr>/g).filter(r => /<td class="c">/.test(r)).map(r => r.replace(/\s+/g, ' '));
  const parent = rowsHtml[1], child = rowsHtml[2];
  ok('a parent row prints exactly as before: number in the No. cell, title first in the description cell',
     /^<tr> <td class="c">2\.0<\/td> <td class="d">Crack Testing Evidence<\/td>/.test(parent), parent);
  ok('a child row carries class child, an EMPTY No. cell, and its number leads the description cell -- the transmittal\'s own layout',
     /^<tr class="child"> <td class="c"><\/td> <td class="d"><span class="lbl">2\.1<\/span>Propeller Crack Testing Evidence<\/td>/.test(child), child);
  ok('...with the same five cells as its parent, Qty/Rate/Amount untouched',
     (child.match(/<td /g) || []).length === 5 && (parent.match(/<td /g) || []).length === 5 &&
     /<td class="c">1<\/td> <td class="r"><\/td> <td class="r"><span class="nc">No Charge<\/span><\/td> <\/tr>$/.test(child), child);
  ok('the row class is not the span class -- the collision that pulled the row out of the grid',
     /class="child"/.test(child) && !/<tr class="sub"/.test(doc) && /<span class="sub">|lineSub/.test(html));

  /* both stylesheets: the screen/print block and STMT_MAIL_CSS */
  const screen = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const mail = html.slice(html.indexOf('const STMT_MAIL_CSS=`'), html.indexOf('`;', html.indexOf('const STMT_MAIL_CSS=`')));
  const sheets = { screen, mail };
  Object.keys(sheets).forEach(k => {
    const css = sheets[k].replace(/\/\*[\s\S]*?\*\//g, '');
    ok(k + ' CSS: the drawing-number rule is typed to the SPAN (span.sub), never a bare .sub that a row class could match',
       /table\.stmt-t span\.sub\{display:block/.test(css) && !/table\.stmt-t \.sub\{/.test(css) && !/(^|[\n}])\s*\.sub\{/.test(css),
       (css.match(/[^\n]*\.sub\{[^\n]*/g) || []).join(' | '));
    ok(k + ' CSS: no rule styles the child row class except through tr.child, so a row can only ever be styled as a row',
       /table\.stmt-t tr\.child td\.d \.lbl\{margin-right:\.5em\}/.test(css) && !/(^|[\s,}])\.child\{/.test(css) && !/table\.stmt-t \.child\{/.test(css),
       (css.match(/[^\n]*child[^\n]*/g) || []).join(' | '));
    ok(k + ' CSS: nothing gives a table ROW display:block',
       !/tr[.\w]*\{[^}]*display:block/.test(css) && !/tr\.child[^{]*\{[^}]*display/.test(css));
  });

  /* the PDF: same layout, from the plan's own coordinates */
  const facts = app.stmtFacts([app.groupOf(rows)]);
  const plan = app.pdfPlan(facts, 'BILLDC-26-009');
  const texts = plan.ops.filter(o => o.t === 'text');
  const M = plan.page.m, W = plan.page.w - 2 * M;
  const cNo = M, cDesc = M + 0.07 * W, descEnd = M + 0.60 * W, cAmt = plan.page.w - M;
  const at = s => texts.find(o => o.s === s);
  const p2 = at('2.0'), c1 = at('2.1'), pt = at('Crack Testing Evidence'), ct = at('Propeller Crack Testing Evidence');
  ok('PDF: the parent number sits in the No. column and its title at the description column',
     !!p2 && !!pt && Math.abs(p2.x - cNo) < 0.01 && Math.abs(pt.x - cDesc) < 0.01, JSON.stringify([p2, pt]));
  ok('PDF: the child number sits where the description column starts -- nothing of that row is drawn in the No. column',
     !!c1 && Math.abs(c1.x - cDesc) < 0.01 && !texts.some(o => o.y === c1.y && Math.abs(o.x - cNo) < 0.01), JSON.stringify(c1));
  ok('PDF: the child title follows its number by the label width plus half an em, on the same baseline',
     !!ct && ct.y === c1.y && Math.abs(ct.x - (cDesc + '2.1'.length * 4.5 + 4.5)) < 0.01, JSON.stringify([c1, ct]));
  ok('PDF: the child row\'s Qty and Amount keep the parent columns, the Rate cell is empty and No Charge appears once',
     texts.filter(o => o.y === c1.y).map(o => o.s).sort().join('|') === '1|2.1|No Charge|Propeller Crack Testing Evidence' &&
     Math.abs(at('No Charge').x - cAmt) < 0.01, JSON.stringify(texts.filter(o => o.y === c1.y)));
  /* the wrap budget shrinks by what the label took: a long child title still
     stops at the description column's end rather than reaching the Qty */
  const lines = texts.filter(o => o.size === 9 && /^(Tailshaft|Crack Testing Evidence With|Words|Appended|So That|Onto|Second|Line|Must|Wrap|A |This)/.test(o.s) && o.x > cDesc);
  ok('PDF: a long child title wraps, and every line ends inside the description column even after the number\'s offset',
     lines.length >= 2 && lines.every(o => o.x + o.s.length * 4.5 <= descEnd - 8 + 0.01),
     JSON.stringify(lines.map(o => [o.s, Math.round(o.x), Math.round(o.x + o.s.length * 4.5), Math.round(descEnd - 8)])));
  app.rows.splice(app.rows.length - rows.length, rows.length);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
