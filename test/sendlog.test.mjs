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
   /'public\.record_billing_send\(text,text,text,text\[\],uuid,text,text,text,numeric\)'/.test(html));
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

console.log('\n--- C. a re-sent billing is marked Revised ---');
const pRows = [
  { id:'r1', line_no:1, group_id:'g1', code:'RSR-DW-082026-001', bill_no:'BILLDWG-26-003',
    client:'Seaford Shipping Lines', vessel:'MV SF Voyager', drawing_no:'D-101',
    drawing_title:'Shell Expansion Plan', qty:2, rate:1500, status:'DRAFT',
    bill_date:'2026-08-19' },
];
app.rows.push.apply(app.rows, pRows);
app.clients.push({ id:'c1', name:'Seaford Shipping Lines',
                   address:'12F Ayala Tower One', billing_email:'ap@seaford.test' });
app.openStmt();
document.getElementById('sClient').value = 'Seaford Shipping Lines';
document.getElementById('sVat').value = '0';
document.getElementById('sTerms').value = '30';
document.getElementById('sFrom').value = '2026-08-01';
document.getElementById('sTo').value = '2026-08-31';

const textOf = pl => pl.ops.filter(o => o.t === 'text').map(o => o.s).join('\n');

// pdfPlan is pure: the send history reaches it through facts, never by a
// lookup of its own, which is what keeps pdfplan.test.mjs's mutate-and-follow
// property true.
const f0 = app.stmtFacts([app.groupOf(pRows)]);
ok('stmtFacts carries a send number', typeof f0.sendNo === 'number', typeof f0.sendNo);
ok('and a revised date', typeof f0.revisedAt === 'string', typeof f0.revisedAt);
ok('never sent reads as 0', f0.sendNo === 0, String(f0.sendNo));

ok('a first send carries no Revised line',
   !/Revised/.test(textOf(app.pdfPlan({ ...f0, sendNo:1, revisedAt:'2026-08-28' },
                                      'BILLDWG-26-003'))));
ok('and neither does a never-sent one',
   !/Revised/.test(textOf(app.pdfPlan(f0, 'BILLDWG-26-003'))));

const rev = app.pdfPlan({ ...f0, sendNo:2, revisedAt:'2026-08-28' }, 'BILLDWG-26-003');
const revOp = rev.ops.find(o => o.t === 'text' && /Revised/.test(o.s));
ok('a re-send carries one', !!revOp, textOf(rev).slice(0, 200));
ok('it names the date', !!revOp && /28 Aug 2026/.test(revOp.s), revOp && revOp.s);
ok('it is right-aligned with the rest of the header block',
   !!revOp && revOp.align === 'right', revOp && String(revOp.align));
ok('it sits on page one', !!revOp && (revOp.p || 0) === 0);
// jsPDF's standard fonts are cp1252; one char above U+00FF re-encodes the
// whole string as UTF-16 and the line turns to rubbish
ok('it stays cp1252-safe', !!revOp && !/[^\u0000-\u00FF]/.test(revOp.s), revOp && revOp.s);

ok('the billing number is unchanged -- no -R suffix',
   textOf(rev).includes('BILLDWG-26-003') && !/-R\d/.test(textOf(rev)));
ok('the tracking code still never reaches the client copy',
   !/RSR-DW-082026-001/.test(textOf(rev)));

// the facts are the only input: mutating them must move the output
ok('a later revised date follows the facts',
   /29 Aug 2026/.test(textOf(app.pdfPlan({ ...f0, sendNo:3, revisedAt:'2026-08-29' },
                                         'BILLDWG-26-003'))));

console.log('\n--- D. the client total is a cross-check, never the source ---');
ok('the column is added idempotently',
   /alter table drawing_billing_send_log\s+add column if not exists client_total/.test(html));
ok('so is the mismatch flag',
   /alter table drawing_billing_send_log\s+add column if not exists total_mismatch/.test(html));
ok('the RPC takes the client total', /p_client_total\s+numeric/.test(html));
// adding a parameter creates an OVERLOAD; PostgREST then sees two candidates
// and cannot choose. The old signature has to go or every send 300s.
ok('the old signature is dropped before the new one is created',
   /drop function if exists public\.record_billing_send\(text,text,text,text\[\],uuid,text,text,text\);/.test(html));
ok('the drop comes before the create',
   html.indexOf('drop function if exists public.record_billing_send(text,text,text,text[],uuid,text,text,text);')
   < html.indexOf('create or replace function public.record_billing_send'));
ok('the revoke list names the new signature',
   /'public\.record_billing_send\(text,text,text,text\[\],uuid,text,text,text,numeric\)'/.test(html));
ok('and no longer the old one',
   !/'public\.record_billing_send\(text,text,text,text\[\],uuid,text,text,text\)'/.test(html));

// the whole point: the client's number is recorded and compared, never used
ok('the snapshot still comes from the table',
   /from public\.drawing_billing b/.test(html));
ok('the client total never feeds the snapshot or the diff',
   !/v_lines\s*:=\s*p_client_total/.test(html) &&
   !/billing_line_diff\(p_client_total/.test(html));
ok('a mismatch is computed against the server total',
   /p_client_total is not null and round\(p_client_total,\s*2\) <> v_total/.test(html));
ok('the RPC returns the flag', /'total_mismatch',\s*v_mismatch/.test(html));

console.log('\n--- E. lSend re-checks the queue, not just the review step ---');
const lSendBlock = (html.match(/\$\('lSend'\)\.onclick=async\(\)=>\{[\s\S]*?\n\};/) || [''])[0];
ok('the lSend block was found', lSendBlock.length > 0);
ok('lSend refuses to send with anything queued',
   /queue\.length/.test(lSendBlock), lSendBlock.slice(0, 200));
ok('it refuses before the number is claimed',
   lSendBlock.indexOf('queue.length') < lSendBlock.indexOf('issueBillNos'),
   'queue check must precede issueBillNos');
ok('the payload carries a total per billing',
   /gid_totals:/.test(lSendBlock), 'gid_totals');
ok('a mismatch is surfaced to the sender',
   /total_mismatch/.test(lSendBlock), 'total_mismatch toast');

console.log('\n--- F. Monitoring says who sent it, and how many times ---');
const listHtml = () => document.getElementById('list').innerHTML;
const gidOf = () => app.allGroups()[0].id;

// render() is synchronous and re-runs on every keystroke in the filter box, so
// the badge reads a cache. refreshSendMap fills it; render only reads it.
app.sendMap = {};
app.render();
ok('a never-sent billing gets no badge', !/class="sent"/.test(listHtml()));

app.sendMap = { [gidOf()]: { send_no:1, sent_by_email:'raffy@rsr.test',
                             sent_at:'2026-08-28T09:00:00Z' } };
app.render();
ok('a first send is badged', /class="sent"/.test(listHtml()), listHtml().slice(0, 300));
ok('it names the sender, local part only',
   /Sent · raffy/.test(listHtml()) && !/rsr\.test</.test(listHtml()),
   (listHtml().match(/<span class="sent"[^>]*>[^<]*/) || [''])[0]);
ok('a first send carries no count, mirroring the PDF',
   !/Sent ×/.test(listHtml()), listHtml().slice(0, 300));
ok('the full address is still available on hover',
   /title="raffy@rsr\.test"/.test(listHtml()));

app.sendMap = { [gidOf()]: { send_no:3, sent_by_email:'raffy@rsr.test',
                             sent_at:'2026-08-28T09:00:00Z' } };
app.render();
ok('a re-send shows the count', /Sent ×3 · raffy/.test(listHtml()),
   (listHtml().match(/<span class="sent"[^>]*>[^<]*/) || [''])[0]);

ok('the badge sits in row-meta, not the row head',
   /class="row-meta"[\s\S]{0,400}class="sent"/.test(listHtml()) &&
   !/class="row-head"[\s\S]{0,300}class="sent"/.test(listHtml()));

console.log('\n--- F2. refreshSendMap keeps the newest row per billing ---');
net.mode = 'online';
net.script.push({ match:'drawing_billing_send_log', method:'GET', status:200, body:[
  { gid:'g-1', send_no:3, sent_by_email:'raffy@rsr.test', sent_at:'2026-08-28T09:00:00Z' },
  { gid:'g-1', send_no:2, sent_by_email:'someone@rsr.test', sent_at:'2026-08-27T09:00:00Z' },
  { gid:'g-1', send_no:1, sent_by_email:'someone@rsr.test', sent_at:'2026-08-26T09:00:00Z' },
  { gid:'g-2', send_no:1, sent_by_email:'raffy@rsr.test', sent_at:'2026-08-26T09:00:00Z' },
]});
await app.refreshSendMap();
ok('one entry per billing', Object.keys(app.sendMap).length === 2,
   JSON.stringify(Object.keys(app.sendMap)));
ok('and it is the newest send', app.sendMap['g-1'].send_no === 3,
   JSON.stringify(app.sendMap['g-1']));
ok('the other billing is kept too', app.sendMap['g-2'].send_no === 1);
ok('it asks the server newest first',
   net.calls.some(c => /order=send_no\.desc/.test(c.url)),
   JSON.stringify(net.calls.slice(-1).map(c => c.url)));

net.mode = 'offline';
app.sendMap = { keep:'me' };
await app.refreshSendMap();
ok('offline leaves the cache alone and does not throw',
   app.sendMap.keep === 'me', JSON.stringify(app.sendMap));
net.mode = 'online';

console.log('\n--- F3. render stays synchronous ---');
// an accidental `async function render` would resolve to a promise everywhere
// it is called and break nothing loudly -- every caller ignores the return
const renderSrc = (html.match(/\nfunction render\(\)\{[\s\S]*?\n\}/) || [''])[0];
ok('the render block was found', renderSrc.length > 0);
ok('render is not async', !/^\s*async function render/m.test(html));
ok('and awaits nothing', !/\bawait\b/.test(renderSrc),
   (renderSrc.match(/.*\bawait\b.*/) || [''])[0]);

console.log('\n--- F4. a send whose total did not match is flagged for good ---');
// The concern is a document already out in the world, not the current state:
// send 4 of BILLDWG-26-002 went to a client at 30,000 while the database
// totalled 20,000, and send 5 was clean. Flagging only the latest send would
// show that billing as fine.
app.sendMap = { [gidOf()]: { send_no:5, sent_by_email:'raffy@rsr.test',
                             sent_at:'2026-08-28T09:00:00Z', bad:[4] } };
app.render();
ok('the clean latest send still shows its own badge', /Sent ×5 · raffy/.test(listHtml()));
ok('and the earlier mismatch is flagged', /class="bad"/.test(listHtml()),
   listHtml().slice(0, 400));
ok('naming which send', /send 4/.test(listHtml()),
   (listHtml().match(/<span class="bad"[^>]*>[^<]*/) || [''])[0]);
ok('the long form is on the title',
   /title="[^"]*does not match[^"]*"/.test(listHtml()),
   (listHtml().match(/<span class="bad"[^>]*/) || [''])[0]);

app.sendMap = { [gidOf()]: { send_no:5, sent_by_email:'raffy@rsr.test',
                             sent_at:'2026-08-28T09:00:00Z', bad:[2,4] } };
app.render();
ok('several are named in order', /sends 2, 4/.test(listHtml()),
   (listHtml().match(/<span class="bad"[^>]*>[^<]*/) || [''])[0]);

app.sendMap = { [gidOf()]: { send_no:5, sent_by_email:'raffy@rsr.test',
                             sent_at:'2026-08-28T09:00:00Z', bad:[] } };
app.render();
ok('a clean history is not flagged', !/class="bad"/.test(listHtml()));

console.log('\n--- F5. refreshSendMap collects every mismatch, not just the newest ---');
net.mode = 'online';
net.script.push({ match:'drawing_billing_send_log', method:'GET', status:200, body:[
  { gid:'g-9', send_no:5, sent_by_email:'raffy@rsr.test', total_mismatch:false },
  { gid:'g-9', send_no:4, sent_by_email:'raffy@rsr.test', total_mismatch:true  },
  { gid:'g-9', send_no:3, sent_by_email:'raffy@rsr.test', total_mismatch:false },
  { gid:'g-9', send_no:2, sent_by_email:'raffy@rsr.test', total_mismatch:true  },
  { gid:'g-9', send_no:1, sent_by_email:'raffy@rsr.test', total_mismatch:false },
]});
await app.refreshSendMap();
ok('the newest send is still the entry', app.sendMap['g-9'].send_no === 5,
   JSON.stringify(app.sendMap['g-9']));
ok('every mismatched send is collected',
   JSON.stringify(app.sendMap['g-9'].bad) === '[2,4]',
   JSON.stringify(app.sendMap['g-9'].bad));
ok('the query asks for the flag',
   net.calls.some(c => /total_mismatch/.test(c.url)),
   JSON.stringify(net.calls.slice(-1).map(c => c.url)));

net.script.push({ match:'drawing_billing_send_log', method:'GET', status:200, body:[
  { gid:'g-8', send_no:1, sent_by_email:'raffy@rsr.test', total_mismatch:false },
]});
await app.refreshSendMap();
ok('a clean billing gets an empty list, not undefined',
   Array.isArray(app.sendMap['g-8'].bad) && app.sendMap['g-8'].bad.length === 0,
   JSON.stringify(app.sendMap['g-8']));

console.log('\n--- F6. a later clean send does not clear an earlier flag ---');
ok('lSend keeps the history it already had',
   /\(prev\.bad\|\|\[\]\)/.test(html), 'lSend must carry prev.bad forward');
ok('and records a new mismatch',
   /res\.total_mismatch/.test(html) && /bad\.push\(/.test(html), 'lSend mismatch capture');

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
