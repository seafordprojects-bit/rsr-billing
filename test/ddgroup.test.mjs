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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
