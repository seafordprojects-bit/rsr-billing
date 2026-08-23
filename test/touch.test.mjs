import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || path.join(ROOT, 'index.html');
const FN_SRC = path.join(ROOT, 'supabase', 'functions', 'send-statement', 'index.ts');
// Touch targets. The heights here are CSS declarations, not measured layout —
// section 2 of MANUAL-TEST.md is still the real check, in the hand.
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (name, cond, extra='') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const html = fs.readFileSync(SRC, 'utf8');
const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
const rules = [...css.matchAll(/\n([#.][A-Za-z0-9_.\-\[\]="\s,:>()]+)\{([^}]*)\}/g)]
  .map(m => [m[1].trim(), m[2]]);
const ruleFor = (sel) => (rules.find(r => r[0] === sel) || [])[1];
const heightOf = (sel) => {
  const b = ruleFor(sel);
  if (!b) return null;
  const mh = b.match(/min-height:(\d+)px/);       if (mh) return +mh[1];
  const h  = b.match(/(?<!min-)height:(\d+)px/);  if (h)  return +h[1];
  const p  = b.match(/padding:(\d+)px/), f = b.match(/font-size:([\d.]+)px/);
  return (p && f) ? +p[1] * 2 + Math.round(parseFloat(f[1]) * 1.45) : null;
};

console.log('\n--- the four that were called out ---');
for (const [sel, what] of [
  ['.gtoggle',   'card expand control'],
  ['.chip',      'status filter chips'],
  ['.icon-btn',  'header icons'],
  ['.mini',      'Settings row up/down/x'],
]) {
  const h = heightOf(sel);
  ok(`${what} (${sel}) is at least 44px`, h !== null && h >= 44, String(h));
}

console.log('\n--- raised with them, for consistency ---');
for (const [sel, what] of [
  ['.act',            'row and Settings action buttons'],
  ['.cmb-pop button', 'typeahead suggestion rows'],
]) {
  const h = heightOf(sel);
  ok(`${what} (${sel}) is at least 44px`, h !== null && h >= 44, String(h));
}

console.log('\n--- already comfortable, still are ---');
for (const sel of ['.seg button', '.seg.sub button', '.fab', '.sheet-foot button']) {
  const h = heightOf(sel);
  ok(`${sel} is at least 44px`, h !== null && h >= 44, String(h));
}

console.log('\n--- icons scaled with their buttons ---');
ok('header icon glyph grew', /\.icon-btn svg\{width:19px/.test(css),
   (css.match(/\.icon-btn svg\{[^}]*\}/) || [''])[0]);
ok('mini icon glyph grew', /\.mini svg\{width:16px/.test(css),
   (css.match(/\.mini svg\{[^}]*\}/) || [''])[0]);

console.log('\n--- nothing interactive left small ---');
const SMALL = rules.filter(([sel, b]) => {
  if (!/^(\.|#)/.test(sel)) return false;
  if (/svg|::|:hover|\[disabled\]|\.on\b/.test(sel)) return false;
  if (!/(button|\.act|\.chip|\.mini|\.icon-btn|\.fab|\.gtoggle|\.seg)/.test(sel)) return false;
  const h = heightOf(sel);
  return h !== null && h < 44;
});
ok('no interactive rule declares under 44px', SMALL.length === 0,
   SMALL.map(r => r[0] + '=' + heightOf(r[0]) + 'px').join(', '));

console.log('\n--- checkbox rows rely on their label, which is fine ---');
ok('.pick-item is a label in the markup', /<label class="pick-item">/.test(html));
ok('.chk is a label in the markup', /<label class="chk"/.test(html));

console.log('\n--- three 44px buttons still fit a Settings row at 380px ---');
const impH = ruleFor('.imp-h');
const gap = +(impH.match(/gap:(\d+)px/) || [0, 9])[1];
const rowWidth = 380 - 32 /* page padding */ - 26 /* card padding+border */;
const fixed = 3 * 44 + 4 * gap + 18 /* checkbox */;
ok('the label still has room beside them', rowWidth - fixed > 90,
   (rowWidth - fixed) + 'px left for the label');
ok('and it can ellipsis if not', /\.imp-h \.fn\{[^}]*text-overflow:ellipsis/.test(css));

console.log('\n--- dead .acct rules are gone ---');
ok('no .acct rule remains', !/\n\.acct[{ ]/.test(css));
ok('and nothing used it', !/class="acct"/.test(html));

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
