// receive.test.mjs — the receive-drydock-job Edge Function under a shimmed
// Deno, exactly like fn.test.mjs does for send-statement. fetch is the mock
// database: the only thing the function may call is the RPC.
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FN_SRC = path.join(ROOT, 'supabase', 'functions', 'receive-drydock-job', 'index.ts');
let pass = 0, fail = 0;
const ok = (name, cond, extra='') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const ENV = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key',
              SUPABASE_ANON_KEY: 'anon-key', DRYDOCK_INGRESS_SECRET: 's3cret' };
let handler = null;
globalThis.Deno = { serve: (h) => { handler = h; }, env: { get: (k) => ENV[k] } };
const net = { calls: [], rpcStatus: 200, rpcBody: { ok:true, created:true, group_id:'dd-1', code:'RSR-DC-092026-001', unpriced:[] } };
globalThis.fetch = async (url, opts={}) => {
  net.calls.push({ url: String(url), method: opts.method, headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null });
  return { ok: net.rpcStatus < 400, status: net.rpcStatus, text: async () => JSON.stringify(net.rpcBody) };
};
const mod = await import(pathToFileURL(FN_SRC).href);
const JOB = (over={}) => Object.assign({
  dispatch_id: '11111111-1111-4111-8111-111111111111', draft_id: '22222222-2222-4222-8222-222222222222',
  source: 'drydocking', project_no: '25-016', vessel: 'MV "SF RISER"', client: 'Seaford Shipping Lines, Inc.',
  client_address: '1st Street, Cebu City', client_email: 'billing@seaford.test',
  documents: [{ title:'Transmittal', pages:1 }, { title:'Load Line Certificate', pages:1 }],
  sent_at: '2026-09-09T10:20:00Z', email_provider_id: 'msg_1',
  confirmed_by: 'Raffy J. Ramirez', confirmed_at: '2026-09-09T10:19:00Z',
  completed_by: 'Raffy J. Ramirez', completed_at: '2026-09-09T10:16:25Z' }, over);
// secret === null: no header at all. secret === undefined: the correct one.
const post = (body, secret='s3cret', method='POST') => {
  const headers = { 'Content-Type': 'application/json' };
  if (secret !== null) headers['x-drydock-secret'] = secret === undefined ? 's3cret' : secret;
  return handler(new Request('https://fn.test/receive-drydock-job', {
    method, headers, body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined }));
};
const status = async r => r.status;

console.log('\n--- A. gate ---');
ok('GET is 405', await status(await post(null, 's3cret', 'GET')) === 405);
ok('wrong secret is 403, no database call', await status(await post(JOB(), 'nope')) === 403 && net.calls.length === 0);
ok('missing secret header is 403', await status(await post(JOB(), null)) === 403);
const saved = ENV.DRYDOCK_INGRESS_SECRET; delete ENV.DRYDOCK_INGRESS_SECRET;
ok('unset secret on the deploy is 500 (fail closed), even with a matching header', await status(await post(JOB(), undefined)) === 500);
ENV.DRYDOCK_INGRESS_SECRET = saved;
ok('bad JSON is 400', await status(await post('{not json', 's3cret')) === 400);
ok('no database call was made by any gate case', net.calls.length === 0, String(net.calls.length));

console.log('\n--- B. validation, before any database call ---');
for (const [label, over, re] of [
  ['missing dispatch_id', { dispatch_id: undefined }, /dispatch_id/],
  ['non-uuid dispatch_id', { dispatch_id: 'abc' }, /dispatch_id/],
  ['non-uuid draft_id', { draft_id: 'abc' }, /draft_id/],
  ['empty documents', { documents: [] }, /documents/],
  ['documents not a list', { documents: 'Transmittal' }, /documents/],
  ['document without title', { documents: [{ pages: 1 }] }, /title/],
  ['non-integer pages', { documents: [{ title:'X', pages:'two' }] }, /pages/],
  ['blank client', { client: '   ' }, /client/],
  ['billable that is not a boolean', { documents: [{ title:'X', billable:'no' }] }, /billable/],
]) {
  net.calls.length = 0;
  const r = await post(JOB(over)); const b = await r.json();
  ok(`${label}: 400 naming the field, no RPC call`, r.status === 400 && re.test(b.error) && net.calls.length === 0, JSON.stringify(b));
}
{
  const v = mod.validate(JOB({ client: ' Sea\r\nford   Lines ', vessel: 'MV\tX', documents: [{ title: ' Load Line\r\n Certificate ', pages: '2' }] }));
  ok('validate() turns header bytes into a space (send-statement convention), collapses whitespace, coerces pages',
     v.ok && v.job.client === 'Sea ford Lines' && v.job.vessel === 'MV X' && v.job.documents[0].title === 'Load Line Certificate' && v.job.documents[0].pages === 2,
     JSON.stringify(v));
  const w = mod.validate(JOB({ dispatch_id: '11111111-1111-4111-8111-111111111111'.toUpperCase(), sent_at: 'yesterday' }));
  ok('validate() lowercases ids and drops an unparseable timestamp to null rather than refusing the job',
     w.ok && w.job.dispatch_id === '11111111-1111-4111-8111-111111111111' && w.job.sent_at === null, JSON.stringify(w));
  const bl = mod.validate(JOB({ documents: [{ title:'Certificate of Drydocking', pages:1 }, { title:'Drydocking List of Vessel', pages:1, billable:false }, { title:'Docking Plan' }] }));
  ok('validate() carries billable through: absent -> true, false -> false, and a hardcopy item with no pages is accepted',
     bl.ok && bl.job.documents.map(d => d.billable).join() === 'true,false,true' && bl.job.documents[2].pages === null,
     JSON.stringify(bl.ok ? bl.job.documents : bl));
}

console.log('\n--- C. happy path ---');
net.calls.length = 0;
let r = await post(JOB()); let b = await r.json();
ok('200 created:true with group id and code', r.status === 200 && b.ok === true && b.created === true && b.group_id === 'dd-1' && b.code === 'RSR-DC-092026-001', JSON.stringify(b));
const c = net.calls[0];
const FIELDS = ['dispatch_id','draft_id','source','project_no','vessel','client','client_address','client_email','documents','sent_at','email_provider_id','confirmed_by','confirmed_at','completed_by','completed_at'];
ok('one RPC call, service key on both headers, payload under p with every field',
   net.calls.length === 1 && /\/rest\/v1\/rpc\/receive_drydock_job$/.test(c.url) && c.method === 'POST' &&
   c.headers.apikey === 'service-key' && c.headers.Authorization === 'Bearer service-key' &&
   c.body && c.body.p && FIELDS.every(k => k in c.body.p),
   JSON.stringify(c && Object.keys(c.body.p || {})));
ok('nothing in the payload was sent that validate() did not produce (no passthrough of extra keys)',
   c && c.body && Object.keys(c.body.p).sort().join() === FIELDS.slice().sort().join(), c && Object.keys(c.body.p).sort().join());
ok('the RPC receives billable per document (JOB has it absent -> true)',
   c && c.body && c.body.p.documents.every(d => d.billable === true), JSON.stringify(c && c.body.p.documents));

console.log('\n--- D. duplicate, refusal, database failure ---');
net.rpcBody = { ok:true, created:false, group_id:'dd-1' };
r = await post(JOB()); b = await r.json();
ok('a retry (RPC created:false) is 200 created:false, never 409', r.status === 200 && b.created === false && b.group_id === 'dd-1', JSON.stringify(b));
net.rpcBody = { ok:false, reason:'client is required' };
r = await post(JOB()); b = await r.json();
ok('RPC refusal is 400 carrying the reason', r.status === 400 && /client is required/.test(b.error), JSON.stringify(b));
net.rpcStatus = 500; net.rpcBody = { message: 'db down' };
r = await post(JOB()); b = await r.json();
ok('RPC HTTP failure is 500 so the caller retries', r.status === 500 && /500/.test(b.error), JSON.stringify(b));
net.rpcStatus = 200;
delete ENV.SUPABASE_SERVICE_ROLE_KEY;
ok('missing service key is 500 before any call', await status(await post(JOB())) === 500);
ENV.SUPABASE_SERVICE_ROLE_KEY = 'service-key';

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
