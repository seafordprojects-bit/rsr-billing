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
const html = fs.readFileSync(SRC, 'utf8');
const KEYS = ['rsr_dwg_cfg_v1','rsr_dwg_rows_v1','rsr_dwg_queue_v1','rsr_dwg_session_v1',
              'rsr_dwg_catalog_v1','rsr_dwg_clients_v1','rsr_dwg_shared_v1'];
const YY = String(new Date().getFullYear()).slice(2);

/* A tiny app_settings server with real compare-and-swap semantics. */
const server = { rows: new Map(), patches: 0 };
const parseQ = (url) => {
  const q = {};
  (String(url).split('?')[1] || '').split('&').forEach(p => {
    const [k, v] = p.split('=');
    if (!k || v === undefined) return;
    q[k] = decodeURIComponent(v.replace(/^eq\./, ''));
  });
  return q;
};
const asRows = (out) => ({ ok:true, status:200, json:async()=>out,
                           text:async()=>JSON.stringify(out) });

function installServer() {
  globalThis.fetch = async (url, opts={}) => {
    const u = String(url), m = opts.method || 'GET';
    if (!u.includes('/app_settings')) {
      if (m === 'GET') return asRows([]);
      const b = opts.body ? JSON.parse(opts.body) : {};
      return asRows((Array.isArray(b) ? b : [b]).map((r,i) =>
        Object.assign({}, r, { id: 'srv-' + (++server.patches) + '-' + i })));
    }
    const q = parseQ(u);
    if (m === 'GET') {
      const hit = q.key && server.rows.has(q.key) ? [server.rows.get(q.key)] : [];
      return asRows(q.key ? hit : [...server.rows.values()]);
    }
    if (m === 'POST') {
      const b = JSON.parse(opts.body);
      const merge = String((opts.headers||{}).Prefer||'').includes('merge-duplicates');
      if (server.rows.has(b.key) && !merge) throw new TypeError('duplicate key');
      server.rows.set(b.key, Object.assign({}, server.rows.get(b.key), b));
      return asRows([server.rows.get(b.key)]);
    }
    if (m === 'PATCH') {
      server.patches++;
      const row = server.rows.get(q.key);
      // the CAS: only apply when the filtered columns still match
      if (!row) return asRows([]);
      if (q.seq_year !== undefined && String(row.seq_year) !== q.seq_year) return asRows([]);
      if (q.seq_n !== undefined && String(row.seq_n) !== q.seq_n) return asRows([]);
      Object.assign(row, JSON.parse(opts.body));
      return asRows([row]);
    }
    return asRows([]);
  };
}
const boot = (cfg) => {
  KEYS.forEach(k => globalThis.localStorage.removeItem(k));
  const base = Object.assign({ seededDW:true, url:'https://p.supabase.co', key:'anon' }, cfg||{});
  globalThis.localStorage.setItem('rsr_dwg_cfg_v1', JSON.stringify(base));
  globalThis.localStorage.setItem('rsr_dwg_session_v1', JSON.stringify({
    access_token:'t', refresh_token:'r', expires_at: Date.now()+3600e3, email:'r@rsr.test' }));
  return globalThis.__loadApp();
};

console.log('\n--- A. the table is in the SQL, authenticated only ---');
ok('app_settings created', /create table if not exists app_settings/.test(html));
ok('RLS enabled', /alter table app_settings enable row level security/.test(html));
ok('authenticated-only policy',
   /create policy rsr_dwg_settings_authed on app_settings\s*\n\s*for all to authenticated/.test(html));
ok('no anon policy anywhere', !/to anon/.test(html));
ok('counter columns are plain, for compare-and-swap',
   /seq_year\s+text/.test(html) && /seq_n\s+integer/.test(html));

console.log('\n--- B. url, key and session never leave the device ---');
const shared = html.slice(html.indexOf('function pushSharedSettings'),
                          html.indexOf('function pushSharedSettings') + 600);
ok('pushed payload carries only types, payment and the letter',
   /types/.test(shared) && /payment/.test(shared) && /letter/.test(shared) &&
   !/cfg\.url/.test(shared) && !/cfg\.key/.test(shared) && !/access_token/.test(shared));
ok('settings cache is its own storage key', /rsr_dwg_shared_v1/.test(html));

console.log('\n--- B2. the long settings sheet collapses into panels ---');
// <details> owns open/closed, so there is no JS state to disagree with the DOM.
// These are markup contracts: the harness cannot see layout, only the source.
const PANELS = { types:'cTypeList', catalog:'cCatList', clients:'cCliList',
                 payment:'cBankList', company:'cCo' };
for (const [name, id] of Object.entries(PANELS)) {
  const i = html.indexOf('data-sect="' + name + '"');
  ok('panel ' + name + ' exists', i > -1);
  const end = html.indexOf('</details>', i);
  ok('and still contains #' + id,
     i > -1 && end > -1 && html.slice(i, end).includes('id="' + id + '"'));
}
ok('every panel header is a summary', (html.match(/<summary>/g) || []).length >= 5,
   String((html.match(/<summary>/g) || []).length));
ok('the header meets the 44px touch target',
   /\.sect>summary\{[^}]*min-height:44px/.test(html));
ok('the native marker is hidden, so the chevron is ours',
   /list-style:none/.test(html) && /details-marker\{display:none/.test(html));
ok('which panel was open is remembered in one key', /rsr_dwg_sect_v1/.test(html));
ok('and only one is open at a time',
   /details\.sect[\s\S]{0,200}o\.open=false/.test(html));

console.log('\n--- C. local values migrate up on first sync ---');
server.rows.clear();
installServer();
net.mode = 'online';
let app = boot({
  payee:'Rafael S. Rosales', remitEmail:'billing@rsr.test',
  banks:[{bank:'BDO',name:'RSR',acct:'111'},{bank:'Metrobank',name:'RSR',acct:'222'}],
  billSeries:{ DW:{ y:YY, n:7 } },
});
await new Promise(r => setTimeout(r, 40));
ok('types pushed', server.rows.has('types'));
ok('payment pushed', server.rows.has('payment'));
ok('payee carried up', server.rows.get('payment').value.payee === 'Rafael S. Rosales',
   JSON.stringify(server.rows.get('payment').value.payee));
ok('banks carried up', server.rows.get('payment').value.banks.length === 2);
ok('deposit email carried up',
   server.rows.get('payment').value.remitEmail === 'billing@rsr.test');
ok('per-type prefixes travel inside the type list',
   server.rows.get('types').value.list.some(t => t.bill === 'BILLDWG'));
ok('existing counter carried up',
   server.rows.get('billseq:DW').seq_n === 7, JSON.stringify(server.rows.get('billseq:DW')));
ok('migration marked done', app.cfg.settingsMigrated === true);

console.log('\n--- C2. the covering letter is the firm\'s, not the device\'s ---');
// it used to be per-device, so two phones could send different wording
const CUSTOM = 'Dear {contact}, our billing {billno} is attached. — RSR';
const appL = boot({ letter: CUSTOM });
await new Promise(r => setTimeout(r, 40));
appL.cfg.letter = CUSTOM;
await appL.pushSharedSettings();
await new Promise(r => setTimeout(r, 40));
ok('the letter is published', server.rows.has('letter'));
// guarded: a missing row must report as a failure, not crash the suite
ok('with its text',
   !!server.rows.get('letter') && server.rows.get('letter').value.text === CUSTOM,
   JSON.stringify(server.rows.get('letter') && server.rows.get('letter').value));

const appM = boot();                    // a device that never typed a letter
await new Promise(r => setTimeout(r, 40));
ok('a second device picks it up', appM.cfg.letter === CUSTOM, appM.cfg.letter);
ok('and composes with it', appM.letterTemplate() === CUSTOM);
ok('an empty shared letter still means the standard wording', (() => {
  appM.settings['letter'] = { key:'letter', value:{ text:'' } };
  appM.applySettings();
  return appM.letterTemplate() === appM.LETTER_DEFAULT;
})(), appM.letterTemplate().slice(0, 40));

console.log('\n--- D. a second device reads them instead of re-entering ---');
const app2 = boot();                    // fresh device, empty local settings
await new Promise(r => setTimeout(r, 40));
ok('payee arrives from the table', app2.cfg.payee === 'Rafael S. Rosales', app2.cfg.payee);
ok('deposit email arrives', app2.cfg.remitEmail === 'billing@rsr.test');
ok('banks arrive', app2.cfg.banks.length === 2 && app2.cfg.banks[0].bank === 'BDO');
ok('counter arrives', app2.cfg.billSeries.DW && app2.cfg.billSeries.DW.n === 7,
   JSON.stringify(app2.cfg.billSeries.DW));
ok('it does not re-migrate over the table',
   server.rows.get('payment').value.payee === 'Rafael S. Rosales');

console.log('\n--- E. issuing claims the number from the table ---');
server.rows.set('billseq:DC', { key:'billseq:DC', seq_year:YY, seq_n:4 });
const n1 = await app2.claimBillNo('DC');
ok('claims the next number', n1 === 5, String(n1));
ok('the table moved', server.rows.get('billseq:DC').seq_n === 5);
const n2 = await app2.claimBillNo('DC');
ok('a second claim advances again', n2 === 6, String(n2));

console.log('\n--- F. two devices cannot mint the same number ---');
server.rows.set('billseq:UT', { key:'billseq:UT', seq_year:YY, seq_n:0 });
const [a, b] = await Promise.all([app2.claimBillNo('UT'), app2.claimBillNo('UT')]);
ok('the two claims differ', a !== b, a + ' vs ' + b);
ok('they are 1 and 2', [a, b].sort().join(',') === '1,2', [a, b].join(','));
ok('the table ends at 2', server.rows.get('billseq:UT').seq_n === 2,
   String(server.rows.get('billseq:UT').seq_n));

console.log('\n--- G. a stale local counter cannot win ---');
app2.cfg.billSeries.DC = { y:YY, n:1 };        // device thinks it is far behind
const n3 = await app2.claimBillNo('DC');
ok('the table decides, not the cache', n3 === 7, String(n3));

console.log('\n--- H. year rollover resets that type only ---');
server.rows.set('billseq:DW', { key:'billseq:DW', seq_year:String(Number(YY)-1), seq_n:88 });
const n4 = await app2.claimBillNo('DW');
ok('a new year restarts at 1', n4 === 1, String(n4));
ok('and stamps the current year', server.rows.get('billseq:DW').seq_year === YY);
ok('other types untouched', server.rows.get('billseq:DC').seq_n === 7);

console.log('\n--- I. offline still works, from the cache ---');
net.mode = 'offline';
globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
const app3 = boot({ payee:'Cached Payee', billSeries:{ DW:{ y:YY, n:3 } } });
await new Promise(r => setTimeout(r, 40));
ok('cached settings still readable', app3.cfg.payee === 'Cached Payee', app3.cfg.payee);
ok('preview number comes from the cache',
   app3.nextBillNo('DW') === `BILLDWG-${YY}-004`, app3.nextBillNo('DW'));
ok('edits queue rather than fail', (await (async () => {
  await app3.pushSharedSettings();
  return app3.queue.some(j => j.op === 'upsert' && j.store === 'settings');
})()), JSON.stringify(app3.queue.map(j => j.op)));

console.log('\n--- J. queued settings writes collapse per key ---');
await app3.pushSharedSettings();
await app3.pushSharedSettings();
const ups = app3.queue.filter(j => j.op === 'upsert' && j.key === 'payment');
ok('one pending write per key', ups.length === 1, String(ups.length));

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
