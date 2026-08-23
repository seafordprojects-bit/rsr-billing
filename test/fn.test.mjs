import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || path.join(ROOT, 'index.html');
const FN_SRC = path.join(ROOT, 'supabase', 'functions', 'send-statement', 'index.ts');
// Exercises the send-statement Edge Function handler under a shimmed Deno.
let pass = 0, fail = 0;
const ok = (name, cond, extra='') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};

const ENV = {
  SUPABASE_URL: 'https://proj.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  RESEND_API_KEY: 're_test',
  STATEMENT_FROM: 'RSR <billing@rsr.test>',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
};
let handler = null;
globalThis.Deno = {
  serve: (h) => { handler = h; },
  env: { get: (k) => ENV[k] },
};

// network: /auth/v1/user verifies the JWT, api.resend.com sends
const netState = { user: { id:'u1', email:'raffy@rsr.test' }, userOk: true,
                   resendOk: true, resendBody: { id:'msg_1' }, sentPayload: null,
                   resendStatus: 200,
                   senders: ['raffy@rsr.test'], sendersOk: true,
                   clients: [{ name:'Seaford', billing_email:'billing@seaford.test' }],
                   clientsOk: true, svcAuth: [] };
globalThis.fetch = async (url, opts={}) => {
  if (String(url).includes('/auth/v1/user')) {
    return { ok: netState.userOk, status: netState.userOk ? 200 : 401,
             json: async () => netState.user };
  }
  if (String(url).includes('/rest/v1/billing_senders')) {
    netState.svcAuth.push((opts.headers||{}).Authorization);
    const m = decodeURIComponent(String(url).split('email=eq.')[1] || '');
    return { ok: netState.sendersOk, status: netState.sendersOk ? 200 : 500,
             json: async () => netState.senders.filter(e => e === m).map(e => ({ email:e })),
             text: async () => '' };
  }
  if (String(url).includes('/rest/v1/clients')) {
    netState.svcAuth.push((opts.headers||{}).Authorization);
    const m = decodeURIComponent(String(url).split('billing_email=eq.')[1] || '');
    return { ok: netState.clientsOk, status: netState.clientsOk ? 200 : 500,
             json: async () => netState.clients.filter(c => c.billing_email === m),
             text: async () => '' };
  }
  if (String(url).includes('api.resend.com')) {
    netState.sentPayload = JSON.parse(opts.body);
    return { ok: netState.resendOk, status: netState.resendStatus,
             text: async () => JSON.stringify(netState.resendBody) };
  }
  throw new Error('unexpected fetch: ' + url);
};

await import(pathToFileURL(FN_SRC).href);
if (!handler) { console.error('handler was never registered'); process.exit(1); }

const call = (body, { auth = 'Bearer user-jwt', method = 'POST' } = {}) =>
  handler(new Request('https://fn.test/send-statement', {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  }));

// every scenario now needs a valid attachment to get past the required-PDF
// check, so `good` carries one; section N below overrides or drops it to
// exercise that check itself
const goodAtt = Buffer.from('%PDF-1.4 fake billing').toString('base64');
const good = { to:'billing@seaford.test', client:'Seaford',
               subject:'Statement of Account RSR-SOA-082026-001',
               html:'<h1>Statement</h1>', statement_no:'RSR-SOA-082026-001',
               attachment:{ filename:'BILLDWG-26-001.pdf', content:goodAtt } };

console.log('\n--- A. JWT verification ---');
let r = await call(good, { auth: '' });
ok('no token is rejected 401', r.status === 401, String(r.status));
r = await call(good, { auth: 'Bearer anon-key' });
ok('the anon key is not a session', r.status === 401, String(r.status));
netState.userOk = false;
r = await call(good);
ok('a token the auth server rejects is 401', r.status === 401, String(r.status));
netState.userOk = true;

console.log('\n--- B. input validation ---');
r = await call({ ...good, to: 'not-an-email' });
ok('bad address rejected', r.status === 400, String(r.status));
r = await call({ ...good, to: 'a@b.test, c@d.test' });
ok('comma list rejected (no fan-out)', r.status === 400, String(r.status));
r = await call({ ...good, to: 'a@b.test\nbcc: x@y.test' });
ok('newline in address rejected', r.status === 400, String(r.status));
r = await call({ ...good, html: '   ' });
ok('empty body rejected', r.status === 400, String(r.status));
r = await call({ ...good, html: 'x'.repeat(800_000) });
ok('oversized body rejected 413', r.status === 413, String(r.status));
r = await call(good, { method: 'GET' });
ok('GET rejected 405', r.status === 405, String(r.status));

console.log('\n--- C. header injection ---');
await call({ ...good, subject: 'Statement\r\nBcc: attacker@evil.test' });
ok('CRLF stripped from subject',
   !/[\r\n]/.test(netState.sentPayload.subject), netState.sentPayload.subject);

console.log('\n--- D. a good send ---');
r = await call(good);
let j = await r.json();
ok('returns 200', r.status === 200, String(r.status));
ok('reports ok', j.ok === true, JSON.stringify(j));
ok('echoes the statement number', j.statement_no === 'RSR-SOA-082026-001', JSON.stringify(j));
ok('sends to exactly one recipient',
   Array.isArray(netState.sentPayload.to) && netState.sentPayload.to.length === 1 &&
   netState.sentPayload.to[0] === 'billing@seaford.test',
   JSON.stringify(netState.sentPayload.to));
ok('uses the configured From', netState.sentPayload.from === 'RSR <billing@rsr.test>',
   netState.sentPayload.from);
ok('replies go to the company mailbox, not whoever pressed Send',
   netState.sentPayload.reply_to === 'rsrengineering.services2025@gmail.com',
   netState.sentPayload.reply_to);
ok('html forwarded intact', netState.sentPayload.html === '<h1>Statement</h1>');

console.log('\n--- E. subject falls back to the statement number ---');
await call({ ...good, subject: '' });
ok('derived subject', netState.sentPayload.subject === 'Statement of Account RSR-SOA-082026-001',
   netState.sentPayload.subject);

console.log('\n--- F. mail service failure is reported, not swallowed ---');
netState.resendOk = false; netState.resendStatus = 422;
netState.resendBody = { message: 'domain is not verified' };
r = await call(good);
j = await r.json();
ok('failure surfaces as not-ok', j.ok === false, JSON.stringify(j));
ok('the provider message is passed through',
   String(j.error).includes('domain is not verified'), JSON.stringify(j));
ok('422 maps to a 4xx for the caller', r.status === 400, String(r.status));

console.log('\n--- G. missing secret is a clear error ---');
delete ENV.RESEND_API_KEY;
r = await call(good);
j = await r.json();
ok('500 with a useful message',
   r.status === 500 && String(j.error).includes('RESEND_API_KEY'), JSON.stringify(j));
ENV.RESEND_API_KEY = 're_test';

console.log('\n--- H. CORS preflight ---');
r = await handler(new Request('https://fn.test/send-statement', { method:'OPTIONS' }));
ok('preflight answered', r.status === 200);
ok('allows the needed headers',
   String(r.headers.get('Access-Control-Allow-Headers')).includes('authorization'));

console.log('\n--- I. sender allowlist ---');
// section F deliberately broke the mail mock; put it back
netState.resendOk = true; netState.resendStatus = 200; netState.resendBody = { id:'msg_1' };
netState.senders = [];
r = await call(good);
j = await r.json();
ok('an authenticated non-sender is refused 403',
   r.status === 403 && /not allowed/i.test(j.error), r.status + ' ' + j.error);
netState.senders = ['someone.else@rsr.test'];
r = await call(good);
ok('another allowed sender does not grant this caller', r.status === 403, String(r.status));
netState.senders = ['raffy@rsr.test'];
r = await call(good);
ok('an allowlisted sender passes', r.status === 200, String(r.status));

console.log('\n--- J. authorisation failures fail closed ---');
netState.sendersOk = false;
r = await call(good);
ok('an unreadable allowlist refuses to send', r.status === 500, String(r.status));
netState.sendersOk = true;
delete ENV.SUPABASE_SERVICE_ROLE_KEY;
r = await call(good);
j = await r.json();
ok('a missing service key refuses to send',
   r.status === 500 && /allowlist/i.test(j.error), r.status + ' ' + j.error);
ENV.SUPABASE_SERVICE_ROLE_KEY = 'service-key';

console.log('\n--- K. recipient must be the client on-file address ---');
r = await call({ ...good, to: 'attacker@evil.test' });
j = await r.json();
ok('an unknown address is refused 403',
   r.status === 403 && /not the billing email/i.test(j.error), r.status + ' ' + j.error);

netState.clients = [{ name:'Seaford', billing_email:'billing@seaford.test' },
                    { name:'Other Co', billing_email:'ap@other.test' }];
r = await call({ ...good, to: 'ap@other.test' });
ok('another client address is refused (no cross-client leak)', r.status === 403, String(r.status));
r = await call({ ...good, to: 'ap@other.test', client: 'Other Co' });
ok('that client own statement to its own address is fine', r.status === 200, String(r.status));
r = await call({ ...good, client: '' });
ok('a missing client is rejected 400', r.status === 400, String(r.status));

netState.clientsOk = false;
r = await call(good);
ok('an unreadable clients table fails closed', r.status === 500, String(r.status));
netState.clientsOk = true;

console.log('\n--- L. lookups use the service key, not the caller token ---');
netState.svcAuth.length = 0;
await call(good);
ok('every lookup uses the service role key',
   netState.svcAuth.length >= 2 && netState.svcAuth.every(a => a === 'Bearer service-key'),
   JSON.stringify(netState.svcAuth));

console.log('\n--- M. reply-to is fixed by the function, never taken from the body ---');
await call({ ...good, reply_to: 'spoof@evil.test' });
ok('reply_to ignores any body value',
   netState.sentPayload.reply_to === 'rsrengineering.services2025@gmail.com',
   netState.sentPayload.reply_to);

console.log('\n--- M2. STATEMENT_REPLY_TO retires the sandbox constant ---');
ENV.STATEMENT_REPLY_TO = 'billing@rsr.test';
await call(good);
ok('the secret wins over the constant',
   netState.sentPayload.reply_to === 'billing@rsr.test', netState.sentPayload.reply_to);
// a typo in a secret must not ship a broken header
ENV.STATEMENT_REPLY_TO = 'not an email';
await call(good);
ok('a malformed secret falls back to the constant',
   netState.sentPayload.reply_to === 'rsrengineering.services2025@gmail.com',
   netState.sentPayload.reply_to);
delete ENV.STATEMENT_REPLY_TO;

console.log('\n--- N. the pdf attachment, validated server-side ---');
r = await call({ ...good, attachment: { filename: 'BILLDWG-26-001.pdf', content: goodAtt } });
j = await r.json();
ok('a well-formed attachment is accepted', r.status === 200, JSON.stringify(j));
ok('it reaches Resend as attachments:[{filename, content}]',
   Array.isArray(netState.sentPayload.attachments) &&
   netState.sentPayload.attachments.length === 1 &&
   netState.sentPayload.attachments[0].filename === 'BILLDWG-26-001.pdf' &&
   netState.sentPayload.attachments[0].content === goodAtt,
   JSON.stringify(netState.sentPayload.attachments));

r = await call({ ...good, attachment: { filename: '../etc/passwd.pdf', content: goodAtt } });
ok('a filename with path characters is refused', r.status === 400, String(r.status));
r = await call({ ...good, attachment: { filename: 'billing', content: goodAtt } });
ok('a filename with no .pdf extension is refused', r.status === 400, String(r.status));
r = await call({ ...good, attachment: { filename: 'x'.repeat(90) + '.pdf', content: goodAtt } });
ok('a filename over 80 chars is refused', r.status === 400, String(r.status));

r = await call({ ...good, attachment: { filename: 'BILLDWG-26-001.pdf', content: 'not base64!!' } });
ok('content that is not valid base64 is refused', r.status === 400, String(r.status));
r = await call({ ...good, attachment: { filename: 'BILLDWG-26-001.pdf', content: 'YQ' } }); // not a multiple of 4
ok('base64 with a bad length is refused', r.status === 400, String(r.status));

// 2 MB decoded cap: 'A'.repeat(2_700_000) decodes to ~2,025,000 bytes
const oversized = 'A'.repeat(2_700_000);
r = await call({ ...good, attachment: { filename: 'BILLDWG-26-001.pdf', content: oversized } });
ok('an attachment over the 2 MB decoded cap is refused', r.status === 413, String(r.status));

netState.sentPayload = null;
const { attachment: _drop, ...noAtt } = good;
r = await call(noAtt);
j = await r.json();
ok('a send with no attachment at all is refused', r.status === 400, JSON.stringify(j));
ok('the message names the missing attachment', /attachment/i.test(j.error), JSON.stringify(j));
ok('nothing reaches Resend', netState.sentPayload === null, JSON.stringify(netState.sentPayload));

r = await call({ ...good, attachment: null });
ok('an explicit null attachment is refused the same way', r.status === 400, String(r.status));

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
