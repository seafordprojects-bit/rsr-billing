// Runs every suite. Usage:  node test/run.mjs   [or]   npm test
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const only = process.argv[2];

const suites = readdirSync(HERE)
  .filter(f => f.endsWith('.test.mjs'))
  .filter(f => !only || f.startsWith(only))
  .sort();

if (!suites.length) {
  console.error(only ? `no suite matching "${only}"` : 'no suites found');
  process.exit(1);
}

let totalPass = 0, totalFail = 0, broken = [];

for (const f of suites) {
  const name = f.replace('.test.mjs', '');
  // fn.test.mjs imports the Edge Function, which is TypeScript
  const args = ['--experimental-strip-types', path.join(HERE, f), path.join(ROOT, 'index.html')];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: HERE });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/^(\d+) passed, (\d+) failed/m);
  if (!m) {
    broken.push(name);
    console.log(`${name.padEnd(12)} DID NOT REPORT`);
    console.log(out.trim().split('\n').slice(-6).map(l => '    ' + l).join('\n'));
    continue;
  }
  const [, p, fl] = m;
  totalPass += +p; totalFail += +fl;
  console.log(`${name.padEnd(12)} ${p.padStart(4)} passed, ${fl} failed` +
              (+fl ? '   <-- FAIL' : ''));
  if (+fl) out.split('\n').filter(l => l.includes('FAIL')).forEach(l => console.log('   ' + l.trim()));
}

console.log('\n' + '='.repeat(46));
console.log(`${suites.length} suites, ${totalPass} passed, ${totalFail} failed` +
            (broken.length ? `, ${broken.length} did not run (${broken.join(', ')})` : ''));
process.exit(totalFail || broken.length ? 1 : 0);
