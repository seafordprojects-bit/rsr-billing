import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || path.join(ROOT, 'index.html');
import { net } from './harness.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra='') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const html = fs.readFileSync(SRC, 'utf8');

console.log('\n--- A. the send log is in the SQL ---');
ok('table created', /create table if not exists drawing_billing_send_log/.test(html));
ok('one send number per billing',
   /unique \(gid, send_no\)/.test(html));
ok('send_no, not revision',
   /send_no\s+int\s+not null/.test(html) && !/\brevision\s+int\b/.test(html));
ok('RLS enabled',
   /alter table drawing_billing_send_log enable row level security/.test(html));
ok('readable by authenticated',
   /create policy rsr_dwg_sendlog_read on drawing_billing_send_log\s*\n\s*for select to authenticated/.test(html));
ok('no insert policy — only the service key writes',
   !/on drawing_billing_send_log\s*\n\s*for (all|insert)/.test(html));
ok('the RPC exists', /create or replace function public\.record_billing_send/.test(html));
ok('the diff helper exists', /create or replace function public\.billing_line_diff/.test(html));
ok('the RPC snapshots from the table, not from the caller',
   /from public\.drawing_billing b/.test(html) && !/p_lines/.test(html));
ok('no-charge lines contribute zero, matching amountOf',
   /case when b\.billable is false then 0/.test(html));
ok('the RPC is in the revoke list',
   /'public\.record_billing_send\(text,text,text,text\[\],uuid,text,text,text\)'/.test(html));
ok('so is the diff helper',
   /'public\.billing_line_diff\(jsonb,jsonb\)'/.test(html));
// Revoking the named role alone is not enough: create function grants EXECUTE
// to PUBLIC, and the anon role inherits it. This is a string assertion and
// cannot see the live ACL -- only the has_function_privilege check can.
ok('the revoke takes PUBLIC, not just the named role',
   /revoke execute on function ' \|\| f \|\| ' from public/.test(html));
ok('and authenticated is granted back explicitly',
   /grant execute on function ' \|\| f \|\| ' to authenticated/.test(html));

console.log('\n--- B. the app reads its own send history ---');
net.mode = 'online';
const app = globalThis.__loadApp();
app.cfg.url = 'https://proj.supabase.co'; app.cfg.key = 'anon-key';
app.setSession({ access_token:'t', refresh_token:'r', expires_at: 2e9,
                 user:{ email:'raffy@rsr.test' } });

const ROW = { gid:'g-1', bill_no:'BILLDWG-26-003', send_no:2,
              sent_at:'2026-08-28T09:00:00Z', sent_by_email:'raffy@rsr.test',
              total:'12000.00', change_kind:'decreased', total_delta:'-500.00',
              changed_lines:[{ op:'amended', title:'Rudder Detail Plan' }] };

net.script.push({ match:'drawing_billing_send_log', method:'GET', status:200, body:[ROW] });
const rec = await app.sendLogFor('g-1');
ok('the newest send comes back', !!rec && rec.send_no === 2, JSON.stringify(rec));
ok('with the sender', !!rec && rec.sent_by_email === 'raffy@rsr.test');
ok('and the change kind', !!rec && rec.change_kind === 'decreased');

net.calls.length = 0;
net.script.push({ match:'drawing_billing_send_log', method:'GET', status:200, body:[] });
ok('a never-sent billing is null', (await app.sendLogFor('g-none')) === null);
ok('it asks for the newest row only',
   net.calls.some(c => /order=send_no\.desc/.test(c.url) && /limit=1/.test(c.url)),
   JSON.stringify(net.calls.map(c => c.url)));
ok('and the gid is encoded',
   net.calls.some(c => /gid=eq\.g-none/.test(c.url)),
   JSON.stringify(net.calls.map(c => c.url)));

// this decorates the UI; a billing whose history cannot be read must still send
net.script.push({ match:'drawing_billing_send_log', method:'GET', status:500, body:{} });
ok('a server error is null, not a throw', (await app.sendLogFor('g-1')) === null);
net.mode = 'offline';
ok('offline is null, not a throw', (await app.sendLogFor('g-1')) === null);
net.mode = 'online';

console.log('\n--- B2. lSend tells the function which billings it covers ---');
ok('the payload carries gids',
   /gids:\(p\.list\|\|\[\]\)\.map\(g=>g&&g\.id\)\.filter\(Boolean\)/.test(html),
   'lSend payload');
// the property is that gids ride in the object posted to send-statement, not
// that they sit within N characters of anything -- a comment must not fail it
const payloadBlock = (html.match(/const payload=\{[\s\S]*?\n    \};/) || [''])[0];
ok('the payload block was found', payloadBlock.length > 0);
ok('gids ride in the same payload as statement_no',
   /statement_no:/.test(payloadBlock) && /gids:/.test(payloadBlock),
   payloadBlock.slice(0, 300));

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
