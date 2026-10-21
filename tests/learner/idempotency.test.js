// Idempotency on POST /appointments, checked over HTTP against the real service.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { SLOT, book, useServer } from '../helpers/harness.js';

const api = useServer();
beforeEach(() => api.reset());

test('idempotency: a missing Idempotency-Key is a 400 and books nothing', async () => {
  const res = await api.post('/appointments', { patientId: 'p_123', slot: SLOT });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'idempotency_key_required');
  assert.equal(typeof res.body.error.message, 'string');
  assert.equal((await api.state()).appointments.length, 0);
});

test('idempotency: a replay returns the original response and creates one appointment', async () => {
  const first = await book(api, 'replay-1');
  assert.equal(first.status, 201);
  assert.equal(first.headers.get('idempotency-replayed'), null);

  const second = await book(api, 'replay-1');
  assert.equal(second.status, first.status);
  assert.deepEqual(second.body, first.body);
  assert.equal(second.headers.get('idempotency-replayed'), 'true');

  const state = await api.state();
  assert.equal(state.appointments.length, 1);
  assert.equal(state.events.filter(e => e.kind === 'booked').length, 1);
});

test('idempotency: the same key with a different body is a 409 and books nothing more', async () => {
  const first = await book(api, 'reuse-1');
  assert.equal(first.status, 201);

  const other = await book(api, 'reuse-1', { patientId: 'p_999', slot: SLOT });
  assert.equal(other.status, 409);
  assert.equal(other.body.error.code, 'idempotency_key_reuse');

  // The original answer is still the one on record.
  const again = await book(api, 'reuse-1');
  assert.deepEqual(again.body, first.body);
  assert.equal((await api.state()).appointments.length, 1);
});

test('idempotency: different keys are independent bookings', async () => {
  const a = await book(api, 'indep-a');
  const b = await book(api, 'indep-b');
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.notEqual(a.body.id, b.body.id);
  assert.equal((await api.state()).appointments.length, 2);
});

test('idempotency: the stored key expires on a TTL', async () => {
  await book(api, 'ttl-1');
  const { redis } = await api.state();
  const keys = redis.filter(k => k.key.includes('ttl-1'));
  assert.equal(keys.length, 1);
  assert.ok(keys[0].ttl > 0 && keys[0].ttl <= 86400, `ttl was ${keys[0].ttl}`);
});

test('idempotency: a failed booking does not poison the key, so the retry succeeds', async () => {
  await api.failNextBooking();
  const failed = await book(api, 'fail-1');
  assert.ok(failed.status >= 500, `expected a 5xx, got ${failed.status}`);

  const retry = await book(api, 'fail-1');
  assert.equal(retry.status, 201);
  assert.equal((await api.state()).appointments.length, 1);
});

test('idempotency: five identical POSTs at the same moment create exactly one appointment', async () => {
  const results = await Promise.all(Array.from({ length: 5 }, () => book(api, 'storm-1')));

  for (const r of results) assert.equal(r.status, 201);
  const ids = new Set(results.map(r => r.body.id));
  assert.equal(ids.size, 1, `all five should see the same appointment, got ids ${[...ids]}`);
  assert.equal(results.filter(r => r.headers.get('idempotency-replayed') === 'true').length, 4);

  const state = await api.state();
  assert.equal(state.appointments.length, 1);
  assert.equal(state.events.filter(e => e.kind === 'booked').length, 1);
});
