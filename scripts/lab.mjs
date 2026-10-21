// Lab helper. Plain Node, no dependencies, no shell syntax: runs the same on Linux, macOS and Windows.
//
//   npm run doctor                  check Node, the install, the port and the kit layout
//   npm run baseline                git-commit the starting point, so you can see exactly what changes
//   npm run step -- N               check your work for step N (1, 2, 4, 5, 6, 7 or 8)
//   npm run checkpoint -- N         reset the code to the reference solution for step N (2, 5, 6, 7, 8)
//
// `step` copies the hidden check in, runs it, and removes it again, so `npm test` never changes under you.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, rmdirSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const kit = path.resolve(app, '..');
const checksDir = path.join(kit, 'checks');
const checkpointsDir = path.join(kit, 'checkpoints');
const [, , command, arg] = process.argv;

const STEPS = {
  1: 'the bug is reproduced: a retried POST books the same appointment twice',
  2: 'the middleware: 400 without a key, 409 for a different body, the TTL, and no duplicate on a replay',
  4: 'the retry scenario: the same key and body again returns the original response, with one row and one SMS',
  5: 'the cache: a second read skips the database, and a booking invalidates it',
  6: 'concurrent retries: five identical requests at once create exactly one appointment, and a failure can be retried',
  7: 'the queue: the booking returns at once, the SMS is delivered later, retried, and never twice',
  8: 'the model call: it times out cleanly, retries only what is retryable, and returns typed errors',
  demo: 'presenter: the migration, the backfill and the similar-notes endpoint',
};

const say = (...a) => console.log(...a);
const fail = (msg, code = 1) => { console.error(msg); process.exit(code); };

function nodeTest(files) {
  return spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], { cwd: app, stdio: 'inherit' }).status ?? 1;
}

function portFree(port) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

function lockHolder() {
  const lock = path.join(app, '.data', 'pg.lock');
  if (!existsSync(lock)) return null;
  const pid = Number(readFileSync(lock, 'utf8'));
  try { process.kill(pid, 0); return pid; } catch (e) { return e.code === 'EPERM' ? pid : null; }
}

async function doctor() {
  let bad = 0;
  const ok = m => say(`  ok    ${m}`);
  const no = (m, fix) => { bad += 1; say(`  FAIL  ${m}\n        -> ${fix}`); };

  const [maj] = process.versions.node.split('.').map(Number);
  maj >= 20 ? ok(`Node ${process.versions.node}`) : no(`Node ${process.versions.node} is too old`, 'install Node 20 or newer');
  existsSync(path.join(app, 'node_modules', 'express')) ? ok('dependencies installed') : no('node_modules is missing', 'run `npm ci` in this folder');
  existsSync(checksDir) && existsSync(checkpointsDir) ? ok('checks/ and checkpoints/ found next to this folder') : no('checks/ or checkpoints/ not found next to clinic-api/', 're-extract the kit zip and keep the folders together');
  (await portFree(4000)) ? ok('port 4000 is free for the service') : no('port 4000 is already in use', 'stop the other process (an old `npm run dev`?)');
  const pid = lockHolder();
  pid ? no(`the database folder is held by process ${pid}`, 'that is the running server. Stop it before migrate/backfill') : ok('the database folder is not in use');
  const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
  git.status === 0 ? ok(git.stdout.trim()) : say('  warn  git not found: `npm run baseline` will be skipped (use the editor diff instead)');

  say(bad ? `\n${bad} problem(s) above. Fix them, then run \`npm run doctor\` again.` : '\nReady. Next: npm test');
  process.exit(bad ? 1 : 0);
}

function baseline() {
  const git = (...a) => spawnSync('git', ['-C', app, ...a], { encoding: 'utf8' });
  try {
    if (git('--version').status !== 0) return say('git not found: skipping. In Step 3, use the editor diff instead.');
    if (!existsSync(path.join(app, '.git'))) git('-c', 'init.defaultBranch=main', 'init', '-q');
    git('add', '-A');
    const r = git('-c', 'user.name=lab', '-c', 'user.email=lab@local', 'commit', '-q', '-m', 'baseline: starting point');
    say(r.status === 0 ? 'Baseline committed. `git diff` and the editor diff now show only what you change.'
                       : 'Nothing new to commit (a baseline already exists).');
  } catch (e) {
    say(`baseline skipped: ${e.message}`);
  }
}

function step(n) {
  if (!STEPS[n]) fail(`Unknown step "${n}". Use one of: ${Object.keys(STEPS).join(', ')}`);
  say(`\nSTEP ${n}: ${STEPS[n]}\n`);

  const file = n === 'demo' ? 'demo.test.js' : `step${n}.test.js`;
  const src = path.join(checksDir, file);
  if (!existsSync(src)) fail(`Missing ${src}. Is checks/ next to clinic-api/?`);
  const destDir = path.join(app, 'tests', 'steps');
  const dest = path.join(destDir, file);
  mkdirSync(destDir, { recursive: true });
  cpSync(src, dest);
  let status;
  try { status = nodeTest([dest]); }
  finally { rmSync(dest, { force: true }); try { rmdirSync(destDir); } catch { /* not empty */ } }

  // Step 6 also wants your OWN tests, written in tests/learner/, and passing.
  if (n === '6' && status === 0) {
    const dir = path.join(app, 'tests', 'learner');
    const names = existsSync(dir) ? readdirSync(dir).filter(f => /\.test\.[cm]?js$/.test(f)) : [];
    const need = ['idempotency', 'cache'];
    const missing = need.filter(k => !names.some(f => f.startsWith(k)));
    if (missing.length) {
      say(`\nThe service is correct, but tests/learner/ has no ${missing.map(k => `${k}.test.js`).join(' or ')} yet. Ask Claude Code to write them (the Step 6 prompt).`);
      status = 1;
    } else {
      say('\nYour own tests:');
      status = nodeTest(names.map(f => path.join(dir, f)));
    }
  }

  say(status === 0 ? `\nSTEP ${n} PASSED` : `\nSTEP ${n} not passing yet. Read the first failure above, fix it with Claude Code, and run this again.${n === 'demo' ? '' : `\nStuck? npm run checkpoint -- ${n}`}`);
  process.exit(status);
}

function listFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? listFiles(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name))]);
}

function checkpoint(name) {
  const dir = path.join(checkpointsDir, name === 'demo-done' ? 'demo-done' : `step-${name}`);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`No checkpoint "${name}". Use one of: 2, 5, 6, 7, 8 (demo-done is for the presenter).`);
  const pid = lockHolder();
  if (pid) fail(`The server (process ${pid}) is running. Stop it (Ctrl+C in the \`npm run dev\` terminal) and run this again.`);

  const backup = path.join(app, '.checkpoint-backup', new Date().toISOString().replace(/[:.]/g, '-'));
  const apply = (from, to) => cpSync(from, to, { recursive: true, force: true });

  // src/ and migrations/ are REPLACED (files the reference does not have are removed), tests/ and scripts/ are overlaid.
  for (const folder of ['src', 'migrations']) {
    const from = path.join(dir, folder);
    if (!existsSync(from)) continue;
    const to = path.join(app, folder);
    if (existsSync(to)) {
      mkdirSync(backup, { recursive: true });
      cpSync(to, path.join(backup, folder), { recursive: true });
      const keep = new Set(listFiles(from));
      for (const f of listFiles(to)) if (!keep.has(f)) rmSync(path.join(to, f), { force: true });
    }
    apply(from, to);
  }
  for (const folder of ['tests', 'scripts']) {
    const from = path.join(dir, folder);
    if (existsSync(from)) apply(from, path.join(app, folder));
  }
  rmSync(path.join(app, '.data'), { recursive: true, force: true }); // a fresh database that matches this code

  say(`The code now matches the reference solution for step ${name}, with a fresh database.${existsSync(backup) ? `\nYour previous code was saved in ${path.relative(app, backup)}` : ''}`);
  say('Run `npm test` to confirm, then carry on with the next step.');
}

switch (command) {
  case 'doctor': await doctor(); break;
  case 'baseline': baseline(); break;
  case 'step': step(String(arg)); break;
  case 'checkpoint': checkpoint(String(arg)); break;
  default: fail('Usage: node scripts/lab.mjs <doctor | baseline | step N | checkpoint N>');
}
