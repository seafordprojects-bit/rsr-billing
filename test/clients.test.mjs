import { fileURLToPath } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.argv[2] = process.argv[2] || path.join(ROOT, 'index.html');
import { net } from './harness.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra='') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const configure = (app) => {
  app.cfg.url = 'https://proj.supabase.co';
  app.cfg.key = 'anon-key';
  globalThis.localStorage.setItem('rsr_dwg_cfg_v1', JSON.stringify(app.cfg));
};

console.log('\n--- 1. a duplicate client insert heals into a fill-only update ---');
net.mode = 'online';
net.script.length = 0;
net.calls.length = 0;
const app = globalThis.__loadApp();
configure(app);
app.setSession({ access_token:'tok-1', refresh_token:'ref-1', expires_in:3600,
                 user:{ email:'raffy@rsr.test' } });

// the server already holds the row, with the corrected email and no contact
net.script.push({ match:'/rest/v1/clients', method:'POST', status:409,
  body:{ code:'23505',
         message:'duplicate key value violates unique constraint "clients_name_key"' } });
net.script.push({ match:'/rest/v1/clients?select=*&name=eq.', method:'GET', status:200,
  body:[{ id:'srv-9', name:'Seaford Shipping Lines', salutation:'Mr. Chua',
          contact_person:null, address:null,
          billing_email:'rsrengineering.services2025@gmail.com' }] });

await app.cliSave({ name:'Seaford Shipping Lines', salutation:'Mr. Chua',
  contact_person:'Ashford Chua', address:'BREDCO 3, Reclamation Area, Bacolod City',
  billing_email:'raffyramirez00@gmail.com' }, true);

const patch = net.calls.find(c => c.method === 'PATCH');
ok('a PATCH was sent', !!patch, JSON.stringify(net.calls));
ok('the queue is empty', app.queue.length === 0, 'queue=' + app.queue.length);
ok('nothing was marked dead', app.deadJobs().length === 0);
ok('exactly one Seaford record locally',
   app.clients.filter(c => c.name === 'Seaford Shipping Lines').length === 1,
   JSON.stringify(app.clients));
ok('the local row adopted the server id',
   app.clients.find(c => c.name === 'Seaford Shipping Lines').id === 'srv-9');
ok('no loc- row survives', !app.clients.some(c => String(c.id).startsWith('loc-')));
ok("the server's corrected email won",
   app.clients.find(c => c.name === 'Seaford Shipping Lines').billing_email
     === 'rsrengineering.services2025@gmail.com');
ok('the locally typed contact filled the gap',
   app.clients.find(c => c.name === 'Seaford Shipping Lines').contact_person
     === 'Ashford Chua');

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
