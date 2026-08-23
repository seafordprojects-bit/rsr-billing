import { fileURLToPath } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || path.join(ROOT, 'index.html');
import { net } from './harness.mjs';
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (name, cond, extra='') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const el = id => document.getElementById(id);
const html = fs.readFileSync(SRC, 'utf8');
const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));

console.log('\n--- the mark is inlined once, not per use ---');
const uses = (html.match(/data:image\/png;base64,/g) || []).length;
ok('exactly one embedded image', uses === 1, String(uses));
const m = css.match(/url\("data:image\/png;base64,([A-Za-z0-9+/=]+)"\)/);
ok('it sits in a CSS url()', !!m);
const b64 = m ? m[1] : '';
ok('base64 is a sane size for a single file', b64.length < 8192,
   (b64.length / 1024).toFixed(1) + ' KB');

console.log('\n--- and it is a real, small PNG ---');
const png = Buffer.from(b64, 'base64');
ok('PNG signature', png.slice(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
ok('square', w === h, `${w}x${h}`);
ok('big enough for print at 46px', w >= 144, String(w));
ok('not the full-resolution original', w < 400, String(w));
ok('decoded bytes are far smaller than the source',
   png.length < 8000, png.length + ' bytes');

console.log('\n--- it covers every place the mark appears ---');
ok('one rule targets both the app mark and the printed one',
   /\.mark,\.stmt-hd \.m\{/.test(css));
ok('scaled to fill the box', /background-size:cover/.test(css));
ok('the underlying text is hidden on screen', /color:transparent/.test(css));
ok('app header still carries the mark', /<div class="mark">RSR<\/div>/.test(html));
ok('the gate does too', (html.match(/<div class="mark">RSR<\/div>/g) || []).length >= 2,
   String((html.match(/<div class="mark">RSR<\/div>/g) || []).length));
ok('the printed billing does', /<div class="m">RSR<\/div>/.test(html));
ok('the text is kept for screen readers', /class="mark">RSR</.test(html));

console.log('\n--- email falls back to the text mark ---');
// Gmail strips data: URIs, so the mail stylesheet deliberately omits the rule
const mailCss = html.slice(html.indexOf('const STMT_MAIL_CSS'),
                           html.indexOf('function statementEmailHtml'));
ok('the mail stylesheet carries no embedded image',
   !/data:image/.test(mailCss));
ok('and no reference to the mark rule', !/background-image/.test(mailCss));
ok('it still paints the red box', /\.stmt-hd \.m\{[^}]*background:#C81E23/.test(mailCss),
   (mailCss.match(/\.stmt-hd \.m\{[^}]*\}/) || [''])[0]);
ok('with white text in it', /\.stmt-hd \.m\{[^}]*color:#fff/.test(mailCss));

console.log('\n--- proven on a rendered email ---');
net.mode = 'offline';
['rsr_dwg_cfg_v1','rsr_dwg_rows_v1','rsr_dwg_queue_v1','rsr_dwg_session_v1',
 'rsr_dwg_catalog_v1','rsr_dwg_clients_v1','rsr_dwg_shared_v1']
  .forEach(k => globalThis.localStorage.removeItem(k));
globalThis.localStorage.setItem('rsr_dwg_cfg_v1', JSON.stringify({ seededDW:true }));
el('sNo').value = '';
const app = globalThis.__loadApp();
app.openEntry(null, 'DW');
el('eClient').value = 'Seaford'; el('eVessel').value = 'MV X';
el('eDate').value = '2026-08-21'; el('eRate').value = '1000';
app.mlines = [{ id:null, title:'A Plan', ref:'', qty:1, rate:'',
                billable:true, rev_of:null, rev_no:null }];
app.renderML();
await el('eSave').onclick();
el('sClient').value = 'Seaford';
el('sFrom').value = '2026-01-01'; el('sTo').value = '2026-12-31';
el('sType').value = ''; el('sTerms').value = '30'; el('sVat').value = '0';
app.buildPick();
el('sNo').value = 'BILLDWG-26-001';
app.renderStatement(app.pickedRows());

const doc = el('printRoot').innerHTML;
ok('the printed markup carries the text mark', /<div class="m">RSR<\/div>/.test(doc));
ok('and no inline image of its own', !/data:image/.test(doc));

const mail = app.statementEmailHtml();
ok('the emailed copy embeds no image at all', !/data:image/.test(mail));
ok('so nothing for Gmail to strip', !/base64/.test(mail));
ok('the mark still reads RSR in the email', /<div class="m">RSR<\/div>/.test(mail));
ok('and it is styled as the red box', /\.stmt-hd \.m\{[^}]*background:#C81E23/.test(mail));

console.log('\n--- the source artwork is not committed ---');
const tracked = fs.existsSync(path.join(ROOT, '.gitignore'))
  ? fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8') : '';
ok('full-resolution sources are ignored', /rsr-logo-.*\.png/.test(tracked), tracked.trim());
ok('the generator is kept so the mark can be remade',
   fs.existsSync(path.join(ROOT, 'tools', 'mkicon.py')));

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
