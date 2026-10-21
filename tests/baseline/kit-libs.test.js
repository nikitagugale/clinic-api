// The kit's own building blocks: queue, Redis, embeddings, SMS and model mocks, and the database.
// These stay green all session. If one fails, something under src/lib or src/db.js was changed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Redis from 'ioredis-mock';
import { openDb, createDataAccess } from '../../src/db.js';
import { embed, cosine, toPgVector, DIM } from '../../src/lib/embed.js';
import { createModel } from '../../src/lib/model.js';
import { Queue, Worker } from '../../src/lib/queue.js';
import { createSms } from '../../src/lib/sms.js';
import { sleep } from '../../src/lib/sleep.js';

const fastCfg = { smsLatencyMs: 1, modelLatencyMs: 1, bookingLatencyMs: 1, slotsLatencyMs: 1 };
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(10);
  }
};

test('sleep: an abort signal cancels it and clears the timer', async () => {
  const ac = new AbortController();
  const p = sleep(60000, ac.signal);
  ac.abort();
  await assert.rejects(p, { name: 'AbortError' });
});

test('queue: a worker processes a job and emits completed', async () => {
  const q = new Queue('t-basic');
  const seen = [];
  const w = new Worker('t-basic', async job => {
    seen.push(job.data.n);
    return 'ok';
  });
  let completed = 0;
  w.on('completed', () => completed++);
  await q.add('go', { n: 1 });
  await until(() => completed === 1);
  assert.deepEqual(seen, [1]);
  await w.close();
});

test('queue: adding the same jobId twice runs the work once', async () => {
  const q = new Queue('t-dedupe');
  let runs = 0;
  const w = new Worker('t-dedupe', async () => {
    runs++;
  });
  await q.add('go', {}, { jobId: 'sms-42' });
  await q.add('go', {}, { jobId: 'sms-42' });
  await sleep(100);
  assert.equal(runs, 1);
  await w.close();
});

test('queue: a failing job is retried with exponential backoff, then reported failed', async () => {
  const q = new Queue('t-retry');
  const attempts = [];
  const w = new Worker('t-retry', async () => {
    attempts.push(Date.now());
    throw new Error('boom');
  });
  let failed;
  w.on('failed', (job, err) => {
    failed = { job, err };
  });
  await q.add('go', {}, { attempts: 3, backoff: { type: 'exponential', delay: 40 } });
  await until(() => failed);
  assert.equal(attempts.length, 3);
  assert.ok(attempts[1] - attempts[0] >= 35, 'first retry waits about 40 ms');
  assert.ok(attempts[2] - attempts[1] >= 70, 'second retry waits about 80 ms');
  assert.equal(failed.job.attemptsMade, 3);
  assert.equal(failed.err.message, 'boom');
  await w.close();
});

test('queue: a job that fails once and then succeeds completes', async () => {
  const q = new Queue('t-recover');
  let n = 0;
  const w = new Worker('t-recover', async () => {
    if (++n < 2) throw new Error('first try fails');
  });
  let done = false;
  w.on('completed', () => (done = true));
  await q.add('go', {}, { attempts: 3, backoff: { type: 'fixed', delay: 10 } });
  await until(() => done);
  assert.equal(n, 2);
  await w.close();
});

test('queue: custom job ids follow BullMQ rules: no colon, not only digits', async () => {
  const q = new Queue('t-ids');
  await assert.rejects(q.add('go', {}, { jobId: 'sms:42' }), /cannot contain :/);
  await assert.rejects(q.add('go', {}, { jobId: 42 }), /cannot be integers/);
  await q.add('go', {}, { jobId: 'sms-42' });
});

test('redis: set with an expiry stores a value with a TTL, and del removes it', async () => {
  const redis = new Redis();
  await redis.set('k', 'v', 'EX', 5);
  assert.equal(await redis.get('k'), 'v');
  const ttl = await redis.ttl('k');
  assert.ok(ttl > 0 && ttl <= 5);
  await redis.del('k');
  assert.equal(await redis.get('k'), null);
  await redis.quit();
});

test('embed: 1536 dimensions, unit length, deterministic, and similar notes score higher', () => {
  const a = embed('chest pain radiating to the left arm with shortness of breath');
  const b = embed('chest pain and shortness of breath when walking uphill');
  const c = embed('itchy skin rash on both forearms after a new medication');
  assert.equal(a.length, DIM);
  assert.ok(Math.abs(cosine(a, a) - 1) < 1e-9);
  assert.deepEqual(embed('same text'), embed('same text'));
  assert.ok(cosine(a, b) > cosine(a, c) + 0.2);
  assert.match(toPgVector(a), /^\[-?\d/);
});

test('sms mock: flaky fails twice then delivers; down never delivers', async () => {
  const sms = createSms({ config: fastCfg });
  sms.state.mode = 'flaky';
  await assert.rejects(sms.send('p', 'x'), { status: 503 });
  await assert.rejects(sms.send('p', 'x'), { status: 503 });
  await sms.send('p', 'x');
  assert.equal(sms.state.sent.length, 1);
  sms.reset();
  sms.state.mode = 'down';
  await assert.rejects(sms.send('p', 'x'), { status: 503 });
  assert.equal(sms.state.sent.length, 0);
});

test('model mock: each mode behaves as documented, and an aborted slow call ends at once', async () => {
  const model = createModel({ config: fastCfg });
  assert.match((await model.summarize({ patientId: 'p', slot: 's' })).text, /Routine consultation/);
  model.state.mode = 'bad';
  await assert.rejects(model.summarize({}), { status: 400 });
  model.state.mode = 'unauth';
  await assert.rejects(model.summarize({}), { status: 401 });
  model.state.mode = 'flaky';
  model.state.failures = 0;
  await assert.rejects(model.summarize({}), { status: 503 });
  await assert.rejects(model.summarize({}), { status: 503 });
  assert.ok((await model.summarize({ patientId: 'p', slot: 's' })).text);
  model.state.mode = 'slow';
  const ac = new AbortController();
  const slow = model.summarize({}, { signal: ac.signal });
  ac.abort();
  await assert.rejects(slow, { name: 'AbortError' });
});

test('database: real Postgres, slots shrink when one is booked, cancel refunds, vector extension available', async () => {
  const { pg, close } = await openDb({ dataDir: 'memory://' });
  const db = createDataAccess({ pg, config: fastCfg });
  const before = await db.getAvailableSlots('2026-09-15');
  assert.equal(before.length, 6);
  const a = await db.createAppointment({ patientId: 'p_1', slot: '2026-09-15T10:00:00.000Z' });
  assert.equal(a.slot, '2026-09-15T10:00:00Z');
  assert.equal((await db.getAvailableSlots('2026-09-15')).length, 5);
  await db.cancelAppointment(a.id);
  const kinds = (await db.listEvents()).map(e => e.kind);
  assert.deepEqual(kinds, ['booked', 'cancelled', 'deposit_refunded']);
  await pg.exec('CREATE EXTENSION IF NOT EXISTS vector');
  const { rows } = await pg.query("SELECT '[1,2,3]'::vector <=> '[1,2,3]'::vector AS d");
  assert.equal(Number(rows[0].d), 0);
  assert.equal((await pg.query('SELECT count(*)::int AS n FROM intake_notes')).rows[0].n, 12);
  await close();
});
