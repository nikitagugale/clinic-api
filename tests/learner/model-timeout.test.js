// The model call behind GET /appointments/:id/summary: bounded time, bounded retries, clean failures.
// The test server runs with MODEL_TIMEOUT_MS=300 and MODEL_RETRIES=2 (see FAST_ENV in the harness).
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { book, useServer } from '../helpers/harness.js';
import { callModelWithRetry } from '../../src/services/model-call.js';

const api = useServer();
beforeEach(() => api.reset());

async function summaryFor(key) {
  const made = await book(api, key, { patientId: 'p_300', slot: '2026-09-17T14:00:00Z' });
  const res = await api.get(`/appointments/${made.body.id}/summary`);
  return { res, state: await api.state() };
}

test('model: a slow model gives a 504 model_timeout in bounded time, after 3 attempts', async () => {
  await api.setModel('slow'); // the mock takes 20 s
  const { res, state } = await summaryFor('m-1');
  assert.equal(res.status, 504);
  assert.equal(res.body.error.code, 'model_timeout');
  assert.equal(state.model.calls, 3);
  // 3 x 300 ms timeouts plus at most 200 + 400 ms of backoff, far below the 20 s the model would take.
  assert.ok(res.ms < 3000, `took ${res.ms} ms`);
});

test('model: a flaky model (503, 503, then ok) is retried and the summary arrives', async () => {
  await api.setModel('flaky');
  const { res, state } = await summaryFor('m-2');
  assert.equal(res.status, 200);
  assert.match(res.body.summary, /Routine consultation/);
  assert.equal(state.model.calls, 3);
});

test('model: a rate-limited model (429, 429, then ok) is retried', async () => {
  await api.setModel('limited');
  const { res, state } = await summaryFor('m-3');
  assert.equal(res.status, 200);
  assert.equal(state.model.calls, 3);
});

test('model: a 400 is never retried and answers 502 model_unavailable', async () => {
  await api.setModel('bad');
  const { res, state } = await summaryFor('m-4');
  assert.equal(res.status, 502);
  assert.equal(res.body.error.code, 'model_unavailable');
  assert.equal(state.model.calls, 1);
});

test('model: a 401 is never retried and answers 502 model_unavailable', async () => {
  await api.setModel('unauth');
  const { res, state } = await summaryFor('m-5');
  assert.equal(res.status, 502);
  assert.equal(res.body.error.code, 'model_unavailable');
  assert.equal(state.model.calls, 1);
});

// The helper on its own: the signal is aborted on timeout, and 403 / 422 are not retried.
test('model: the helper aborts the signal on timeout and gives up after the retries', async () => {
  const signals = [];
  const hang = signal => {
    signals.push(signal);
    return new Promise(() => {}); // ignores the signal on purpose: the helper must still return
  };
  await assert.rejects(callModelWithRetry(hang, { timeoutMs: 20, retries: 1 }), { code: 'model_timeout' });
  assert.equal(signals.length, 2);
  assert.ok(signals.every(s => s.aborted));
});

test('model: the helper does not retry 403 or 422, and leaves no timer behind on success', async () => {
  for (const status of [403, 422]) {
    let calls = 0;
    const err = Object.assign(new Error('nope'), { status });
    await assert.rejects(callModelWithRetry(async () => { calls += 1; throw err; }, { timeoutMs: 1000, retries: 2 }), { code: 'model_unavailable', status });
    assert.equal(calls, 1);
  }
  const before = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
  assert.equal(await callModelWithRetry(async () => 'ok', { timeoutMs: 60000, retries: 2 }), 'ok');
  assert.equal(process.getActiveResourcesInfo().filter(r => r === 'Timeout').length, before);
});
