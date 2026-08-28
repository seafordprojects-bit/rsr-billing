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

// This asserted that sendNo 1 shows no Revised line, which encoded the
// off-by-one it was meant to guard: sendNo is the PREVIOUS send, so 1 means a
// copy is already out and this one is the correction. Section G2 covers the
// boundary properly; what belongs here is that a date alone does not mark an
// unsent billing.
ok('a never-sent billing is not revised even with a date',
   !/Revised/.test(textOf(app.pdfPlan({ ...f0, sendNo:0, revisedAt:'2026-08-28' },
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

console.log('\n--- F7. a re-send repaints the card ---');
// The badge update in lSend borrowed its repaint from markBilledNow. On a
// re-send the billing is already BILLED, so markBilledNow short-circuits every
// group and returns BEFORE persist();render() -- sendMap held the new count and
// the DOM kept the old one until a hard refresh. The bug was latent on every
// re-send and on every PAID billing, and no test reached it because they all
// exercised the DRAFT path.

// the precondition: a billing already BILLED is not moved, and not repainted
app.rows.length = 0;
app.rows.push({ id:'srv-rs1', group_id:'g-resend', code:'RSR-DW-082026-011',
  bill_no:'BILLDWG-26-011', client:'Seaford Shipping Lines', vessel:'MV SF CRUISER',
  doc_type:'DW', bill_date:'2026-08-21', drawing_title:'Shell Expansion Plan',
  qty:1, rate:10000, status:'BILLED', billed_date:'2026-08-27', billable:true,
  line_no:0, created_at:'2026-08-21T05:00:00Z' });

app.sendMap = { 'g-resend': { send_no:3, sent_by_email:'raffy@rsr.test',
                              sent_at:'2026-08-28T09:00:00Z', bad:[] } };
app.render();
ok('the card starts at the count it was last painted with',
   /Sent ×3 · raffy/.test(listHtml()), listHtml().slice(0, 300));

// what a re-send does to the cache, without the repaint
app.sendMap['g-resend'].send_no = 4;
const moved = await app.markBilledNow(app.allGroups());
ok('markBilledNow moves nothing for a billing already BILLED',
   moved.n === 0 && moved.queued === 0 && moved.dead === 0, JSON.stringify(moved));
ok('and repaints nothing, so the caller has to',
   /Sent ×3 · raffy/.test(listHtml()),
   'if this now reads x4, markBilledNow renders and this test no longer proves anything');
app.render();
ok('an explicit render picks the new count up',
   /Sent ×4 · raffy/.test(listHtml()), listHtml().slice(0, 300));

// and the fix: lSend owns its own repaint rather than borrowing one
const lSendBlk = (html.match(/\$\('lSend'\)\.onclick=async\(\)=>\{[\s\S]*?\n\};/) || [''])[0];
ok('the lSend block was found', lSendBlk.length > 0);
// Comments stripped first. The comment explaining this very fix contains the
// literal "persist();render()", so searching the raw block found the prose
// after the real statement was deleted -- the assertion passed against the bug
// it exists to catch. A source assertion has to read code, not commentary.
const lSendCode = lSendBlk.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
const iCache = lSendCode.indexOf('sendMap[g.id]=');
ok('lSend writes the cache', iCache > -1);
ok('and repaints after writing it',
   iCache > -1 && lSendCode.indexOf('render()', iCache) > -1,
   'render() must follow the sendMap write inside lSend, not be inherited from markBilledNow');


console.log('\n--- G. the letter can explain a correction ---');
ok('the new keys are whitelisted',
   app.LETTER_KEYS.includes('send_no') &&
   app.LETTER_KEYS.includes('revised_note') &&
   app.LETTER_KEYS.includes('change_note'),
   JSON.stringify(app.LETTER_KEYS));
// the token regex was /\{([a-z]+)\}/ and could never have matched an
// underscore, so every one of these would have been left standing verbatim
ok('an underscore token is substituted at all',
   app.fillLetter('x {send_no} y', { send_no:'2' }) === 'x 2 y',
   app.fillLetter('x {send_no} y', { send_no:'2' }));
ok('an unknown token is still left standing',
   app.fillLetter('a {nope} b', {}) === 'a {nope} b',
   app.fillLetter('a {nope} b', {}));

const f1 = { ...f0, sendNo:0, revisedAt:'', grand:20000 };
let v = app.letterVars(f1, 'BILLDWG-26-003', null);
ok('a first send has no revised note', v.revised_note === '', v.revised_note);
ok('and no change note', v.change_note === '', v.change_note);
ok('send_no counts the send about to happen', v.send_no === '1', v.send_no);

// stmtSend holds the PREVIOUS send, so sendNo 1 means this is send 2
const prior = { send_no:1, total:'20000.00', sent_at:'2026-08-28T09:00:00Z',
  lines:[{ id:'r1', drawing_title:'Shell Expansion Plan', qty:2, rate:1500 },
         { id:'r9', drawing_title:'Rudder Detail Plan',   qty:1, rate:5000 }] };
const f2 = { ...f0, sendNo:1, revisedAt:'2026-08-28', grand:19000,
  list:[{ id:'r1', drawing_title:'Shell Expansion Plan', qty:2, rate:1500 },
        { id:'r9', drawing_title:'Rudder Detail Plan',   qty:1, rate:4000 }] };
v = app.letterVars(f2, 'BILLDWG-26-003', prior);
ok('the second send is a correction',
   /replaces the copy sent on 28 Aug 2026/.test(v.revised_note), v.revised_note);
ok('and says the number is unchanged', /number is unchanged/.test(v.revised_note), v.revised_note);
ok('no -R suffix anywhere in it', !/-R\d/.test(v.revised_note), v.revised_note);
ok('send_no reads 2', v.send_no === '2', v.send_no);
ok('the change note names the direction', /decreased by/.test(v.change_note), v.change_note);
ok('and the amount', /1,000/.test(v.change_note), v.change_note);
ok('and the amended line', /Rudder Detail Plan/.test(v.change_note), v.change_note);
ok('an unchanged line is not named', !/Shell Expansion/.test(v.change_note), v.change_note);

// The diff is computed against what was SENT, not read off the previous row's
// change_kind: that field describes how THAT send differed from the one before
// it, which is a different question and would be wrong here.
const f3 = { ...f2, grand:22000,
  list:[{ id:'r1', drawing_title:'Shell Expansion Plan', qty:2, rate:1500 },
        { id:'r9', drawing_title:'Rudder Detail Plan',   qty:1, rate:5000 },
        { id:'rX', drawing_title:'Capacity Plan',        qty:1, rate:3000 }] };
v = app.letterVars(f3, 'BILLDWG-26-003', Object.assign({}, prior, { change_kind:'decreased' }));
ok('an added line reads as an increase', /increased by/.test(v.change_note), v.change_note);
ok('and the new line is named', /Capacity Plan/.test(v.change_note), v.change_note);

// Deliberate: a re-send where nothing moved says nothing at all. A note
// announcing a correction that is not there reads worse than no note, and a
// billing is often re-sent only because the client mislaid the first copy.
const f4 = { ...f2, grand:20000, list:prior.lines };
v = app.letterVars(f4, 'BILLDWG-26-003', prior);
ok('a re-send with nothing changed says nothing', v.change_note === '', v.change_note);

// but a total that HELD while lines moved is a different case, and does speak
const f5 = { ...f2, grand:20000,
  list:[{ id:'r1', drawing_title:'Shell Expansion Plan', qty:2, rate:1500 },
        { id:'r9', drawing_title:'Rudder Detail Plan',   qty:1, rate:9999 }] };
v = app.letterVars(f5, 'BILLDWG-26-003', prior);
ok('an unchanged total with an amended line still speaks',
   /total amount is unchanged/.test(v.change_note), v.change_note);
ok('and names the line', /Amended: Rudder Detail Plan/.test(v.change_note), v.change_note);
// {revised_note} owns the supersession sentence. change_note carries only the
// arithmetic, so a template using both does not say it twice -- and the app's
// vocabulary stays "billing" rather than drifting to "statement".
ok('change_note does not repeat the supersession sentence',
   !/supersede|replaces the copy/i.test(v.change_note), v.change_note);
ok('and revised_note still carries it, saying billing',
   /replaces the copy sent on/.test(v.revised_note) &&
   /billing/i.test(v.revised_note) && !/statement/i.test(v.revised_note),
   v.revised_note);

console.log('\n--- G2. the PDF marks the FIRST correction, not the second ---');
const tx = pl => pl.ops.filter(o => o.t === 'text').map(o => o.s).join('\n');
ok('never sent is not revised',
   !/Revised/.test(tx(app.pdfPlan({ ...f0, sendNo:0, revisedAt:'' }, 'BILLDWG-26-003'))));
ok('the second send IS revised',
   /Revised/.test(tx(app.pdfPlan({ ...f0, sendNo:1, revisedAt:'2026-08-28' }, 'BILLDWG-26-003'))),
   'sendNo 1 means one prior send, so this copy is the first correction');
ok('and so is the third',
   /Revised/.test(tx(app.pdfPlan({ ...f0, sendNo:2, revisedAt:'2026-08-29' }, 'BILLDWG-26-003'))));

console.log('\n--- F6. a later clean send does not clear an earlier flag ---');
ok('lSend keeps the history it already had',
   /\(prev\.bad\|\|\[\]\)/.test(html), 'lSend must carry prev.bad forward');
ok('and records a new mismatch',
   /res\.total_mismatch/.test(html) && /bad\.push\(/.test(html), 'lSend mismatch capture');
console.log('\n--- H. the default letter carries the notes without a hole ---');
const V = (rn, cn) => ({ contact:'Sir/Madam', billno:'BILLDWG-26-003',
  vessel:'MV SF CRUISER', period:'01 Aug 2026 — 31 Aug 2026',
  total:'PHP 20,000.00', due:'27 Sep 2026', send_no:'1',
  revised_note:rn, change_note:cn });
const REV = 'This billing replaces the copy sent on 28 Aug 2026. The billing number is unchanged.';
const CHG = 'The total has decreased by PHP 1,000.00. Amended: Rudder Detail Plan.';
const blanks = h => (h.match(/<p>\s*<\/p>/g) || []).length;
const paras  = h => (h.match(/<p>/g) || []).length;

ok('the default template carries both placeholders',
   app.LETTER_DEFAULT.includes('{revised_note}') &&
   app.LETTER_DEFAULT.includes('{change_note}'), app.LETTER_DEFAULT);
ok('they sit after the billing paragraph and before the closing',
   app.LETTER_DEFAULT.indexOf('{total}') < app.LETTER_DEFAULT.indexOf('{revised_note}') &&
   app.LETTER_DEFAULT.indexOf('{change_note}') < app.LETTER_DEFAULT.indexOf('Respectfully yours,'));

// a first send: both resolve to nothing and must leave no trace
const first = app.fillLetter(app.LETTER_DEFAULT, V('', ''));
ok('a first send leaves no blank line', !/\n{3,}/.test(first), JSON.stringify(first.slice(-160)));
ok('and no line of only whitespace',
   first.split('\n').every(l => l === '' || l.trim() !== ''), JSON.stringify(first));
ok('and no empty paragraph in the email', blanks(app.letterHtml(first)) === 0,
   app.letterHtml(first));
ok('the closing still follows the billing paragraph directly',
   /agreed terms\.\n\nRespectfully yours,/.test(first), JSON.stringify(first.slice(-160)));

// a correction: one extra paragraph, no hole
const corr = app.fillLetter(app.LETTER_DEFAULT, V(REV, CHG));
ok('a correction adds exactly one paragraph',
   paras(app.letterHtml(corr)) === paras(app.letterHtml(first)) + 1,
   paras(app.letterHtml(first)) + ' -> ' + paras(app.letterHtml(corr)));
ok('both notes land in the same paragraph',
   new RegExp('<p>' + 'This billing replaces').test(app.letterHtml(corr)) &&
   /decreased by PHP 1,000\.00/.test(app.letterHtml(corr)),
   app.letterHtml(corr));
ok('and it still has no empty paragraph', blanks(app.letterHtml(corr)) === 0);

// only one of the two filled -- the leading or trailing space must not survive
const revOnly = app.fillLetter(app.LETTER_DEFAULT, V(REV, ''));
const chgOnly = app.fillLetter(app.LETTER_DEFAULT, V('', CHG));
ok('a revised note alone has no trailing space',
   !/unchanged\. \n/.test(revOnly), JSON.stringify(revOnly.slice(-200)));
ok('a change note alone has no leading space',
   !/\n The total/.test(chgOnly), JSON.stringify(chgOnly.slice(-200)));
console.log('\n--- I. the expanded card lists every send ---');
// refreshSendMap always fetched every row and kept only the newest. The rest
// are now kept in all[] and rendered under the lines, sharing the card's
// existing toggle rather than adding a second one.
const HIST = [
  { gid:'g-h', send_no:3, sent_at:'2026-08-28T09:00:00Z', sent_by_email:'raffy@rsr.test',
    total:'19000.00', change_kind:'decreased', total_mismatch:false },
  { gid:'g-h', send_no:2, sent_at:'2026-08-27T09:00:00Z', sent_by_email:'ana@rsr.test',
    total:'30000.00', change_kind:'increased', total_mismatch:true },
  { gid:'g-h', send_no:1, sent_at:'2026-08-26T09:00:00Z', sent_by_email:'raffy@rsr.test',
    total:'20000.00', change_kind:'first', total_mismatch:false },
];

net.mode = 'online';
net.script.push({ match:'drawing_billing_send_log', method:'GET', status:200, body:HIST });
await app.refreshSendMap();
ok('every row is kept, not just the newest',
   app.sendMap['g-h'].all.length === 3, JSON.stringify(app.sendMap['g-h'].all.length));
ok('newest first', app.sendMap['g-h'].all.map(r => r.send_no).join(',') === '3,2,1',
   app.sendMap['g-h'].all.map(r => r.send_no).join(','));
ok('the newest is still the entry itself', app.sendMap['g-h'].send_no === 3);
ok('and the mismatches are still collected',
   JSON.stringify(app.sendMap['g-h'].bad) === '[2]', JSON.stringify(app.sendMap['g-h'].bad));
ok('letter_text is never asked for',
   !net.calls.some(c => /letter_text/.test(String(c.url))),
   JSON.stringify(net.calls.slice(-1).map(c => c.url)));

const block = app.sendLogLines({ id:'g-h' });
ok('all three sends are listed', (block.match(/class="sl[ "]/g) || []).length === 3, block);
ok('newest at the top', block.indexOf('#3') < block.indexOf('#1'), block);
ok('each names its date', /26 Aug 2026/.test(block) && /28 Aug 2026/.test(block), block);
ok('and its sender, local part only',
   /raffy/.test(block) && /ana/.test(block) && !/rsr\.test/.test(block), block);
ok('and what changed', /decreased/.test(block) && /increased/.test(block), block);
ok('a first send is not labelled with a change', !/first/.test(block), block);
ok('the amount sent is shown', /19,000/.test(block) && /30,000/.test(block), block);

ok('a mismatched send is marked', /class="sl bad"/.test(block), block);
ok('and says why', /total differs from what was sent/.test(block), block);
ok('the clean ones are not marked',
   (block.match(/class="sl bad"/g) || []).length === 1, block);

// nothing tappable: touch.test.mjs holds anything interactive to 44px, and six
// sends of a four-line billing would be a screen of buttons
ok('nothing in the block is interactive',
   !/<button|<a |data-exp|role="button"/.test(block), block);

console.log('\n--- I2. a billing never sent gets no block at all ---');
ok('no history, no block', app.sendLogLines({ id:'g-never' }) === '',
   app.sendLogLines({ id:'g-never' }));
app.sendMap['g-empty'] = { send_no:0, all:[] };
ok('an empty list is the same as none', app.sendLogLines({ id:'g-empty' }) === '');

console.log('\n--- I3. it only renders inside the expanded card ---');
const cardSrc = html.slice(html.indexOf('${open?`<div class="glines">'),
                           html.indexOf('${open?`<div class="glines">') + 200);
ok('the block is gated on the same open flag as the lines',
   /\$\{open\?sendLogLines\(g\)/.test(cardSrc), cardSrc);





console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
