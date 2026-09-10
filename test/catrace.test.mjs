// catrace.test.mjs -- a pull() landing while a catalogue write is in flight.
// 2026-09-10, live: a new catalogue item saved twice as the placeholder "New
// document" with its type and rate correct. flushQueue's guard returned
// NOTHING to a second caller while a flush was running, so pull() -- which
// awaits flushQueue first, and which Settings -> Save calls -- did not wait
// for the in-flight PATCH, fetched the server rows as they were, replaced the
// local object with the placeholder, and every later edit PATCHed the
// placeholder back over the name the server had already accepted. Not a
// name-field bug: every catalogue field and every billing line is exposed.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || path.join(ROOT, 'index.html');
import { net } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, extra='') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const el = id => document.getElementById(id);
const KEYS = ['rsr_dwg_cfg_v1','rsr_dwg_rows_v1','rsr_dwg_queue_v1','rsr_dwg_session_v1','rsr_dwg_catalog_v1','rsr_dwg_clients_v1','rsr_dwg_shared_v1'];
KEYS.forEach(k => globalThis.localStorage.removeItem(k));
globalThis.localStorage.setItem('rsr_dwg_cfg_v1', JSON.stringify({ seededDW:true, url:'https://proj.supabase.co', key:'anon' }));
const app = globalThis.__loadApp();
net.mode = 'online';
app.setSession({ access_token:'t', refresh_token:'r', expires_at: 2e9, user:{ email:'x@rsr.test' } });

// a server that remembers catalogue rows; PATCH answers one tick late so a pull can land mid-flight
const server = { rows: [], patches: [], lines: [], linePatches: [] };
const tick = () => new Promise(r => setTimeout(r, 30));
globalThis.fetch = async (url, opts={}) => {
  const u = String(url), m = opts.method || 'GET';
  const j = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  if (u.includes('drawing_catalog')) {
    if (m === 'POST') { const b = JSON.parse(opts.body); const rows = (Array.isArray(b) ? b : [b]).map(r => Object.assign({}, r, { id: 'srv-' + (server.rows.length + 1) })); server.rows.push(...rows); return j(201, rows); }
    if (m === 'PATCH') { const id = decodeURIComponent(u.split('id=eq.')[1]); const body = JSON.parse(opts.body); server.patches.push({ id, body }); await tick(); const row = server.rows.find(r => r.id === id); if (row) Object.assign(row, body); return j(204, []); }
    if (m === 'GET') return j(200, server.rows.map(r => Object.assign({}, r)));
  }
  if (u.includes('drawing_billing') && !u.includes('send_log')) {
    if (m === 'PATCH') { const id = decodeURIComponent(u.split('id=eq.')[1]); const body = JSON.parse(opts.body); server.linePatches.push({ id, body }); await tick(); const row = server.lines.find(r => r.id === id); if (row) Object.assign(row, body); return j(204, []); }
    if (m === 'GET') return j(200, server.lines.map(r => Object.assign({}, r)));
  }
  return j(200, []);
};
const nameOf = () => ({ local: app.catalog[0] && app.catalog[0].name, server: server.rows[0] && server.rows[0].name });
const lastPatch = () => server.patches[server.patches.length - 1] && server.patches[server.patches.length - 1].body;

console.log('\n--- A. after Add item the cursor is in the new row\'s name field ---');
app.openCfg && app.openCfg();
await el('cCatAdd').onclick();
const list = el('cCatList');
const nameInput = list.querySelector('[data-cf="name"]');
ok('the new row carries the SERVER id (the insert was flushed before the paint)', !!nameInput && /^srv-/.test(nameInput.dataset.ci), nameInput && nameInput.dataset.ci);
ok('and it is focused, ready to type over the placeholder', document.activeElement === nameInput, String(document.activeElement && document.activeElement.dataset && document.activeElement.dataset.cf));

console.log('\n--- B. a pull() landing while the name PATCH is in flight ---');
nameInput.value = 'Drydocking document'; list.fire('input', { target: nameInput });
const changing = (async () => { list.fire('change', { target: nameInput }); await tick(); await tick(); })();
await new Promise(r => setTimeout(r, 5));      // the PATCH is now in flight
await app.pull(true);                          // Settings -> Save does exactly this
await changing;
ok('pull waited for the in-flight write: local and server both hold the typed name', nameOf().local === 'Drydocking document' && nameOf().server === 'Drydocking document', JSON.stringify(nameOf()));
app.renderCatMgr();
const rate = el('cCatList').querySelector('[data-cf="default_rate"]');
rate.value = '2500'; el('cCatList').fire('input', { target: rate }); el('cCatList').fire('change', { target: rate });
await tick(); await tick();
ok('a later rate edit PATCHes the typed name, not the placeholder', lastPatch() && lastPatch().name === 'Drydocking document' && Number(lastPatch().default_rate) === 2500, JSON.stringify(lastPatch()));
ok('the server row ends with the name AND the rate', server.rows[0].name === 'Drydocking document' && Number(server.rows[0].default_rate) === 2500, JSON.stringify(server.rows[0]));

console.log('\n--- C. a pull with a queued write still lands it before fetching ---');
const before = server.patches.length;
app.queue.push({ op:'update', store:'catalog', table:'drawing_catalog', id: app.catalog[0].id, data: Object.assign({}, server.rows[0], { name: 'Queued rename' }) });
await app.pull(true);
ok('the queued update was flushed inside pull (one PATCH) and the local row shows the server result', server.patches.length === before + 1 && nameOf().local === 'Queued rename' && nameOf().server === 'Queued rename', JSON.stringify({ patches: server.patches.length - before, names: nameOf() }));

console.log('\n--- D. two overlapping flushQueue calls send a job once ---');
const before2 = server.patches.length;
app.queue.push({ op:'update', store:'catalog', table:'drawing_catalog', id: app.catalog[0].id, data: Object.assign({}, server.rows[0], { name: 'Once' }) });
await Promise.all([app.flushQueue(), app.flushQueue()]);
ok('the guard still holds: one PATCH, not two', server.patches.length === before2 + 1, String(server.patches.length - before2));


console.log('\n--- E. the same race on a BILLING LINE -- where a stale value is a wrong bill ---');
// The catalogue proves the mechanism; this proves it for the path that prices
// a client's statement. pull() replaces `rows` exactly as it replaces the
// catalogue, and lines have no compare-and-swap. Before dda0d9b this ran:
// local reverted to 1,000 while the server held 2,500, and the next edit
// PATCHed 1,000 back -- a wrong bill.
server.lines = [{ id:'srv-l1', group_id:'g1', line_no:1, code:'RSR-DW-092026-001', doc_type:'DW', bill_date:'2026-09-11', client:'C', vessel:'V',
  drawing_title:'General Arrangement', qty:1, rate:1000, status:'DRAFT', remarks:'', billable:true, created_at:'2026-09-11T00:00:00Z' }];
await app.pull(true);
const line = app.rows.find(r => r.id === 'srv-l1');
ok('the line is local at its server rate', !!line && Number(line.rate) === 1000, line && String(line.rate));
const saving = app.saveRow(Object.assign({}, line, { rate: 2500 }), false);   // PATCH in flight for a tick
await new Promise(r => setTimeout(r, 5));
await app.pull(true);                                                          // a pull lands mid-flight
await saving; await tick();
const lineNow = () => ({ local: Number(app.rows.find(r => r.id === 'srv-l1').rate), server: Number(server.lines[0].rate) });
ok('line race: pull waited for the in-flight rate PATCH -- local and server both 2,500', lineNow().local === 2500 && lineNow().server === 2500, JSON.stringify(lineNow()));
await app.saveRow(Object.assign({}, app.rows.find(r => r.id === 'srv-l1'), { remarks: 'second edit' }), false);
await tick(); await tick();
const lastLine = server.linePatches[server.linePatches.length - 1].body;
ok('line race: the next edit carries 2,500, never the stale 1,000 (the wrong-bill case)', Number(lastLine.rate) === 2500 && lastLine.remarks === 'second edit' && Number(server.lines[0].rate) === 2500,
   JSON.stringify({ lastPatch: { rate: lastLine.rate, remarks: lastLine.remarks }, server: server.lines[0].rate }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
