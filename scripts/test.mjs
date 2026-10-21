// `npm test`: runs every test in tests/baseline and tests/learner with Node's built-in test runner.
//   npm test                          everything
//   npm test -- --grep idempotency    only tests whose name matches (the deck's spelling; maps to Node's flag)
//   npm test -- tests/learner/x.js    only those files
// Why a wrapper: from Node 22, `node --test <folder>` fails with MODULE_NOT_FOUND, so the files are listed explicitly.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function collect(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap(name => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? collect(p) : /\.test\.[cm]?js$/.test(name) ? [p] : [];
  });
}

const args = process.argv.slice(2);
const flags = [];
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--grep' || args[i] === '-g') flags.push(`--test-name-pattern=${args[++i]}`);
  else if (args[i].startsWith('--grep=')) flags.push(`--test-name-pattern=${args[i].slice(7)}`);
  else if (args[i].startsWith('-')) flags.push(args[i]);
  else files.push(path.resolve(args[i]));
}

const targets = files.length ? files : [...collect(path.join(root, 'tests', 'baseline')), ...collect(path.join(root, 'tests', 'learner'))];
if (!targets.length) {
  console.error('No test files found.');
  process.exit(1);
}
// Node 20 prints TAP when its output is not a terminal, and Node 22+ prints "spec". Pin one format everywhere.
if (!flags.some(f => f.startsWith('--test-reporter'))) flags.push('--test-reporter=spec');
const r = spawnSync(process.execPath, ['--test', ...flags, ...targets], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
