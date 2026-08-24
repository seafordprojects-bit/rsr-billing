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
const KEYS = ['rsr_dwg_cfg_v1','rsr_dwg_rows_v1','rsr_dwg_queue_v1','rsr_dwg_session_v1',
              'rsr_dwg_catalog_v1','rsr_dwg_clients_v1'];
const clearLS = () => KEYS.forEach(k => globalThis.localStorage.removeItem(k));
const html = fs.readFileSync(SRC, 'utf8');

console.log('\n--- A. head / supply chain ---');
ok('noindex meta present',
   /<meta name="robots" content="noindex, nofollow">/.test(html));
ok('pdf.js pinned to the verified hash',
   html.includes("sha512-q+4liFwdPC/bNdhUpZx6aXDx/h77yEQtn4I1slHydcbZK34nLaR3cAeYSJshoxIOq3mjEf7xJE8YWIUHMn+oCQ=="));
ok('SRI needs crossOrigin to be enforced', /s\.crossOrigin\s*=\s*'anonymous'/.test(html));

console.log('\n--- A2. installable as an app, not a shortcut ---');
// Chrome dropped the service-worker requirement for the menu's "Install app"
// in v108 on mobile, so the manifest is the whole contract. Miss a field and
// Android silently falls back to a plain home-screen shortcut.
ok('the manifest is linked', /<link rel="manifest" href="manifest\.webmanifest">/.test(html));
const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
ok('it is valid JSON with the app name', mf.name === 'RSR Billing', mf.name);
ok('display is standalone', mf.display === 'standalone', mf.display);
ok('theme colour matches the app chrome', mf.theme_color === '#101F2E', mf.theme_color);
ok('a background colour for the splash', /^#[0-9A-Fa-f]{6}$/.test(mf.background_color || ''),
   mf.background_color);
const sizes = (mf.icons || []).map(i => i.sizes);
ok('a 192px icon', sizes.includes('192x192'), sizes.join(','));
ok('and a 512px icon — both are required', sizes.includes('512x512'), sizes.join(','));
ok('plus a maskable one so Android does not letterbox it',
   (mf.icons || []).some(i => String(i.purpose || '').split(/\s+/).includes('maskable')),
   JSON.stringify((mf.icons || []).map(i => i.purpose)));
// a project-page URL is a subpath, so nothing may be rooted at /
ok('start_url and scope are relative',
   !String(mf.start_url).startsWith('/') && !String(mf.scope).startsWith('/'),
   mf.start_url + ' ' + mf.scope);
ok('so are the icon paths',
   (mf.icons || []).every(i => !String(i.src).startsWith('/') && !/^https?:/.test(i.src)),
   (mf.icons || []).map(i => i.src).join(','));
ok('every icon file is actually committed',
   (mf.icons || []).every(i => fs.existsSync(path.join(ROOT, i.src))),
   (mf.icons || []).map(i => i.src + '=' + fs.existsSync(path.join(ROOT, i.src))).join(' '));
ok('iOS gets its own icon, which ignores the manifest',
   /<link rel="apple-touch-icon" href="apple-touch-icon\.png">/.test(html) &&
   fs.existsSync(path.join(ROOT, 'apple-touch-icon.png')));
// the offline queue is the persistence story; a cache would only serve stale app code
ok('no service worker is registered', !/serviceWorker\s*\.\s*register/.test(html));

console.log('\n--- B. generated SQL makes the bucket private ---');
clearLS();
net.mode = 'offline';
let app = globalThis.__loadApp();
el('sqlWrap').hidden = true;
el('cSql').onclick();
const sql = el('cSqlBox').value;
ok('bucket created private', /values \('drawings','drawings',false\)/.test(sql));
ok('an existing bucket is flipped private', /do update set public = false/.test(sql));
ok('no public=true left behind', !/public = true/.test(sql));
ok('storage policy still authenticated-only', /to authenticated[\s\S]*bucket_id = 'drawings'/.test(sql));
ok('migration strips public URLs to a path',
   /update drawing_billing[\s\S]*regexp_replace[\s\S]*storage\/v1\/object/.test(sql));
ok('clients table added', /create table if not exists clients/.test(sql));
ok('clients RLS authenticated-only',
   /create policy rsr_dwg_clients_authed on clients\s*\n\s*for all to authenticated/.test(sql));

console.log('\n--- C. objectPath normalises every shape a row might hold ---');
const base = 'https://proj.supabase.co';
ok('public URL -> path',
   app.objectPath(base + '/storage/v1/object/public/drawings/RSR-DW-01__plan.pdf')
     === 'RSR-DW-01__plan.pdf');
ok('signed URL with token -> path',
   app.objectPath(base + '/storage/v1/object/sign/drawings/a.pdf?token=abc.def')
     === 'a.pdf');
ok('authenticated URL -> path',
   app.objectPath(base + '/storage/v1/object/authenticated/drawings/a.pdf') === 'a.pdf');
ok('a bare path is left alone', app.objectPath('RSR-DW-01__plan.pdf') === 'RSR-DW-01__plan.pdf');
ok('percent-encoding is decoded',
   app.objectPath(base + '/storage/v1/object/public/drawings/a%20b.pdf') === 'a b.pdf');
ok('empty stays empty', app.objectPath('') === '' && app.objectPath(null) === '');

console.log('\n--- D. upload returns a path, not a URL ---');
app.cfg.url = base; app.cfg.key = 'anon-key'; app.cfg.bucket = 'drawings';
globalThis.localStorage.setItem('rsr_dwg_cfg_v1', JSON.stringify(app.cfg));
app.setSession({ access_token:'tok', refresh_token:'ref', expires_in:3600, user:{email:'r@rsr.test'} });
net.mode = 'online';
const stored = await app.uploadPdf({ name:'shell plan.pdf' }, 'RSR-DW-082026-001');
ok('returns a bare object path', !/^https?:/.test(stored) && stored.includes('.pdf'), stored);
ok('no public URL segment', !stored.includes('/object/public/'), stored);

console.log('\n--- E. signing uses the session token ---');
net.calls.length = 0;
net.signed = true;
globalThis.fetch = async (url, opts={}) => {
  net.calls.push({ url, method: opts.method, auth: (opts.headers||{})['Authorization'],
                   body: opts.body });
  return { ok:true, status:200,
           json: async () => ({ signedURL: '/object/sign/drawings/a.pdf?token=xyz' }),
           text: async () => '' };
};
const u = await app.signedUrl('a.pdf');
const call = net.calls[0];
ok('POSTs to the sign endpoint',
   call.url.includes('/storage/v1/object/sign/drawings/a.pdf') && call.method === 'POST',
   call.url);
ok('sends the session token, not the anon key', call.auth === 'Bearer tok', call.auth);
ok('asks for a one hour expiry', JSON.parse(call.body).expiresIn === 3600, call.body);
ok('returns an absolute URL',
   u === base + '/storage/v1/object/sign/drawings/a.pdf?token=xyz', u);

console.log('\n--- F. the PDF affordance is a button, not a static link ---');
ok('renders a button with data-pdf', /data-pdf="\$\{esc\(r\.id\)\}"/.test(html));
ok('no public href for attachments', !/object\/public/.test(html.split('const SQL')[0] || html));
ok('list click routes to openPdf', /closest\('\[data-pdf\]'\)[\s\S]{0,60}openPdf/.test(html));

console.log('\n--- G. per-client billing email ---');
clearLS();
net.mode = 'offline';
globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
app = globalThis.__loadApp();
app.cfg.url = base; app.cfg.key = 'k';
ok('unknown client has no email', app.billingEmail('Seaford') === '');
await app.setBillingEmail('Seaford', 'billing@seaford.test');
ok('email stored', app.billingEmail('Seaford') === 'billing@seaford.test');
ok('queued as a clients insert',
   app.queue.some(j => j.store === 'clients' && j.table === 'clients'),
   JSON.stringify(app.queue.map(j => j.store)));
await app.setBillingEmail('Seaford', 'ap@seaford.test');
ok('updating does not duplicate the client', app.clients.length === 1,
   'n=' + app.clients.length);
ok('new value kept', app.billingEmail('Seaford') === 'ap@seaford.test');
const n = app.clients.length;
app = globalThis.__loadApp();
ok('clients survive a reload', app.clients.length === n && app.billingEmail('Seaford') === 'ap@seaford.test');

console.log('\n--- H. emailed statement carries its own stylesheet ---');
app.rows.push({ id:'r1', code:'RSR-DW-082026-001', doc_type:'DW', bill_date:'2026-08-21',
                client:'Seaford', vessel:'MV SF Voyager', drawing_title:'Shell Expansion',
                qty:1, rate:1500, status:'DRAFT' });
el('sClient').value='Seaford'; el('sFrom').value='2026-08-01'; el('sTo').value='2026-08-31';
el('sNo').value='RSR-SOA-082026-001'; el('sVat').value='0'; el('sTerms').value='30';
app.renderStatement([app.rows[0]]);
const mail = app.statementEmailHtml();
ok('is a full document', mail.startsWith('<!doctype html>'));
ok('embeds a stylesheet', mail.includes('<style>') && mail.includes('.stmt-hd'));
ok('no unresolved CSS variables', !/var\(--/.test(mail));
// the billing itself is the attachment; the body is the covering letter
ok('carries the letter it was given',
   app.statementEmailHtml('Dear Sir/Madam, Billing BILLDWG-26-001 attached.')
     .includes('Billing BILLDWG-26-001 attached.'));
ok('and no billing table', !/class="stmt"/.test(mail));

console.log('\n--- I. the email is saved before the send, not after ---');
const src = html.slice(html.indexOf("$('sEmailBtn').onclick"),
                       html.indexOf("$('sEmailBtn').onclick") + 1600);
// The send now sits behind the letter-review step, so the ordering is
// structural rather than sequential: the Email button saves the address and
// only then sets pendingSend, and lSend refuses to run without it.
const iSave = src.indexOf('setBillingEmail(client,to)');
const iPend = src.indexOf('pendingSend={');
ok('setBillingEmail runs before the review opens',
   iSave > -1 && iPend > -1 && iSave < iPend,
   'save@' + iSave + ' pending@' + iPend);
const snd = html.slice(html.indexOf("$('lSend').onclick"),
                       html.indexOf("$('lSend').onclick") + 1400);
ok('and the send itself is gated on that having happened',
   /if\(!pendingSend\)\{[\s\S]{0,120}return;\}/.test(snd) &&
   snd.indexOf("fnPost('send-statement'") > -1, snd.slice(0, 160));
ok('the send is abandoned if the save did not sync',
   /if\(queue\.length\)\{[\s\S]{0,120}return;/.test(src));
ok('the client name is sent so the function can verify the recipient',
   /client:client,/.test(src));

console.log('\n--- J. allowlist table is in the SQL and locked down ---');
ok('billing_senders created', /create table if not exists billing_senders/.test(sql));
ok('RLS enabled on it', /alter table billing_senders enable row level security/.test(sql));
ok('no policy grants ordinary sessions access to it',
   !/create policy[^;]*on billing_senders/.test(sql));

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
