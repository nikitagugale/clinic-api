// The running service, checked over HTTP. These stay green through every step: they pin the parts of the API
// that never change (shapes, validation, the error envelope, the lab controls). The behaviours you are about to
// change (retries, caching, the queue, timeouts) are checked by `npm run step -- N`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { book, useServer } from '../helpers/harness.js';

const api = useServer();

test('health answers', async () => {
  const res = await api.get('/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
});

test('available slots: the date and a list of free ISO slots', async () => {
  const res = await api.get('/appointments/available-slots?date=2026-09-15');
  assert.equal(res.status, 200);
  assert.equal(res.body.date, '2026-09-15');
  assert.equal(res.body.slots.length, 6);
  assert.equal(res.body.slots[0], '2026-09-15T09:00:00Z');
});

test('booking: 201 with the appointment, and one new row', async () => {
  await api.reset();
  const res = await book(api, 'base-1', { patientId: 'p_900', slot: '2026-09-17T11:00:00Z' });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { id: 1, patientId: 'p_900', slot: '2026-09-17T11:00:00Z', status: 'booked' });
  const state = await api.state();
  assert.equal(state.appointments.length, 1);
});

test('booking: a bad body is a 400 in the standard error envelope', async () => {
  const res = await book(api, 'base-2', { patientId: '' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'invalid_request');
  assert.equal(typeof res.body.error.message, 'string');
});

test('booking: broken JSON is a 400 invalid_json', async () => {
  const res = await fetch(`${api.url}/appointments`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'base-3' }, body: '{oops' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'invalid_json');
});

test('every route also answers under /v1', async () => {
  const res = await api.get('/v1/appointments/available-slots?date=2026-09-15');
  assert.equal(res.status, 200);
  assert.equal(res.body.date, '2026-09-15');
});

test('cancel: an unknown appointment is a 404 in the envelope', async () => {
  const res = await api.post('/appointments/9999/cancel', {}, { 'Idempotency-Key': 'base-4' });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'not_found');
});

test('summary: the model answers for an appointment, and an unknown one is a 404', async () => {
  await api.reset();
  const made = await book(api, 'base-5', { patientId: 'p_901', slot: '2026-09-17T14:00:00Z' });
  const res = await api.get(`/appointments/${made.body.id}/summary`);
  assert.equal(res.status, 200);
  assert.match(res.body.summary, /Routine consultation for p_901/);
  assert.equal((await api.get('/appointments/9999/summary')).status, 404);
});

test('unknown routes are a 404 in the envelope', async () => {
  const res = await api.get('/nope');
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'not_found');
});

test('lab controls: reset empties the bookings, and a bad mode is rejected', async () => {
  await book(api, 'base-6', { patientId: 'p_902', slot: '2026-09-18T09:00:00Z' });
  await api.reset();
  const state = await api.state();
  assert.equal(state.appointments.length, 0);
  assert.equal(state.events.length, 0);
  assert.equal((await api.setSms('sideways')).status, 400);
  assert.equal((await api.setModel('sideways')).status, 400);
});
