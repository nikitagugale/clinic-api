// Test harness: starts the REAL service as a child process on a free port, with fast simulated latencies and an
// in-memory database, and gives you a small client for it. Tests built on this check behaviour over HTTP, so they
// work whatever you named your files. Use it in your own tests (tests/learner/).
//
//   import { test, beforeEach } from 'node:test';
//   import { useServer, book } from '../helpers/harness.js';
//   const api = useServer();                       // starts the service before the tests, stops it after them
//   beforeEach(() => api.reset());
//   test('...', async () => {
//     const res = await book(api, 'key-1');        // POST /appointments with an Idempotency-Key
//     const state = await api.state();             // what is in the database, Redis, the queue, the SMS log
//   });
//
// Always use useServer() rather than your own before/after hooks: `npm test -- --grep x` skips the tests that do not
// match but can still run an `after` hook, and a hook that touches a server that never started fails the whole run.
import { spawn } from 'node:child_process';
import { after, before } from 'node:test';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Small numbers so a check takes seconds, not minutes. Override per test with startServer({ env: {...} }).
export const FAST_ENV = {
  BOOKING_LATENCY_MS: '150',
  SLOTS_LATENCY_MS: '150',
  SMS_LATENCY_MS: '300',
  MODEL_LATENCY_MS: '20',
  MODEL_TIMEOUT_MS: '300',
  MODEL_RETRIES: '2',
};

export async function startServer({ env = {}, dataDir = 'memory://' } = {}) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ...FAST_ENV, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  const errors = [];
  let url = null;
  const ready = new Promise((resolve, reject) => {
    const out = createInterface({ input: child.stdout });
    out.on('line', line => {
      logs.push(line);
      const m = /^listening on (http:\/\/\S+)/.exec(line);
      if (m) {
        url = m[1];
        resolve();
      }
    });
    createInterface({ input: child.stderr }).on('line', line => errors.push(line));
    child.once('exit', code => reject(new Error(`The server exited before it was ready (code ${code}).\n${errors.join('\n')}`)));
    setTimeout(() => reject(new Error(`The server did not start within 20 s.\n${errors.join('\n')}`)), 20000).unref();
  });
  await ready;

  // The server must never keep the test process alive. Node's runner can skip every test in a file (for example
  // `npm test -- --grep idempotency`) after this `before` hook has already started a server, and then `after` never runs.
  // So: let the process exit without waiting for the child, and kill the child when it does.
  child.unref();
  child.stdout.unref();
  child.stderr.unref();
  process.once('exit', () => {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  });

  async function request(method, pathname, { body, headers } = {}) {
    const t0 = Date.now();
    const res = await fetch(url + pathname, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, headers: res.headers, body: json ?? text, ms: Date.now() - t0 };
  }

  const api = {
    url,
    logs,
    request,
    get: (p, headers) => request('GET', p, { headers }),
    post: (p, body, headers) => request('POST', p, { body, headers }),
    state: async () => (await request('GET', '/_lab/state')).body,
    reset: () => request('POST', '/_lab/reset', { body: {} }),
    setSms: mode => request('POST', '/_lab/sms', { body: { mode } }),
    setModel: mode => request('POST', '/_lab/model', { body: { mode } }),
    failNextBooking: () => request('POST', '/_lab/fail-next-booking', { body: {} }),
    async stop() {
      if (child.exitCode !== null) return;
      const exited = new Promise(r => child.once('exit', r));
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
      await exited;
    },
  };
  return api;
}

/**
 * Starts the service before the tests in this file and stops it after them. Returns the client right away: its methods
 * fill in once the server is up, so you can write `const api = useServer();` at the top of the file.
 */
export function useServer(options) {
  const api = {};
  before(async () => {
    Object.assign(api, await startServer(options));
  });
  after(() => api.stop?.());
  return api;
}

export const SLOT = '2026-09-15T10:00:00Z';

/** POST /appointments with an Idempotency-Key. Pass a different body to book a different patient or slot. */
export const book = (api, key, body = { patientId: 'p_123', slot: SLOT }) => api.post('/appointments', body, { 'Idempotency-Key': key });

/** Polls `fn` until it returns something truthy, or throws after `timeoutMs`. */
export async function eventually(fn, { timeoutMs = 10000, everyMs = 100, message = 'condition not met in time' } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(message);
    await new Promise(r => setTimeout(r, everyMs));
  }
}

/** A check jsdom-style "advisory": prints a warning, never fails. */
export function advise(ok, message) {
  if (!ok) console.warn(`ADVISORY (not graded): ${message}`);
}
