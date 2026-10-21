// The confirmation SMS is queued: the booking never waits for it, and the queue retries it.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { book, eventually, useServer } from '../helpers/harness.js';

const api = useServer();
beforeEach(() => api.reset());

test('sms queue: the booking returns before the SMS is sent, and the text is exact', async () => {
  const res = await book(api, 'q-1');
  assert.equal(res.status, 201);
  assert.ok(res.ms < 250, `booking took ${res.ms} ms; it should not wait for the 300 ms SMS`);
  assert.equal((await api.state()).sms.sent.length, 0);

  const state = await eventually(async () => { const s = await api.state(); return s.sms.sent.length === 1 && s; });
  assert.equal(state.sms.sent[0].text, `Appointment ${res.body.id} confirmed for ${res.body.slot}`);
  assert.equal(state.queue.sms[0].id, `sms-${res.body.id}`);
});

test('sms queue: a down provider still gives 201, and the job is tried 3 times then fails', async () => {
  await api.setSms('down');
  const res = await book(api, 'q-2');
  assert.equal(res.status, 201);
  const state = await eventually(async () => { const s = await api.state(); return s.queue.sms?.[0]?.state === 'failed' && s; }, { timeoutMs: 15000 });
  assert.equal(state.queue.sms[0].attemptsMade, 3);
  assert.equal(state.sms.attempts, 3);
  assert.equal(state.sms.sent.length, 0);
  assert.equal(state.appointments.length, 1);
});

test('sms queue: a flaky provider is retried until the SMS is delivered once', async () => {
  await api.setSms('flaky');
  const res = await book(api, 'q-3');
  assert.equal(res.status, 201);
  const state = await eventually(async () => { const s = await api.state(); return s.sms.sent.length === 1 && s; }, { timeoutMs: 15000 });
  assert.equal(state.sms.attempts, 3);
  assert.equal(state.queue.sms[0].state, 'completed');
});

test('sms queue: a replayed booking queues no second message', async () => {
  const res = await book(api, 'q-4');
  await book(api, 'q-4');
  await eventually(async () => (await api.state()).sms.sent.length === 1);
  await new Promise(r => setTimeout(r, 600));
  const state = await api.state();
  assert.equal(state.sms.sent.length, 1);
  assert.equal(state.queue.sms.length, 1);
  assert.equal(state.queue.sms[0].id, `sms-${res.body.id}`);
});
