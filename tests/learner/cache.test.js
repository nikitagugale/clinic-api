// Cache-aside on GET /appointments/available-slots, checked over HTTP against the real service.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { book, useServer } from '../helpers/harness.js';

const api = useServer();
beforeEach(() => api.reset());

const DATE = '2026-09-15';
const OTHER_DATE = '2026-09-16';
const slotsPath = date => `/appointments/available-slots?date=${date}`;
const slotQueries = async () => (await api.state()).stats.slotQueries;

test('cache: the second read is served without a second database query', async () => {
  const first = await api.get(slotsPath(DATE));
  const second = await api.get(slotsPath(DATE));

  assert.equal(first.status, 200);
  assert.deepEqual(second.body, first.body);
  assert.deepEqual(Object.keys(first.body).sort(), ['date', 'slots']);
  assert.equal(await slotQueries(), 1);
});

test('cache: the cached entry has a TTL, and each date is cached separately', async () => {
  await api.get(slotsPath(DATE));
  await api.get(slotsPath(OTHER_DATE));

  const { redis, stats } = await api.state();
  assert.equal(stats.slotQueries, 2);
  const cached = redis.filter(k => k.key.includes(DATE) && !k.key.includes('version'));
  assert.ok(cached.length >= 1, 'expected a cache key containing the date');
  for (const k of cached) assert.ok(k.ttl > 0 && k.ttl <= 30, `ttl was ${k.ttl}`);
  assert.ok(redis.some(k => k.key.includes(OTHER_DATE)), 'the other date has its own key');
});

test('cache: booking a slot invalidates the cached date at once', async () => {
  const before = await api.get(slotsPath(DATE));
  assert.ok(before.body.slots.includes('2026-09-15T10:00:00Z'));

  assert.equal((await book(api, 'cache-book-1')).status, 201);

  const after = await api.get(slotsPath(DATE));
  assert.ok(!after.body.slots.includes('2026-09-15T10:00:00Z'), 'the booked slot must not be offered');
  assert.equal(after.body.slots.length, before.body.slots.length - 1);
  assert.equal(await slotQueries(), 2);

  // And the fresh answer is cached again.
  await api.get(slotsPath(DATE));
  assert.equal(await slotQueries(), 2);
});

test('cache: booking one date leaves other dates cached', async () => {
  await api.get(slotsPath(OTHER_DATE));
  await book(api, 'cache-book-2');
  await api.get(slotsPath(OTHER_DATE));
  assert.equal(await slotQueries(), 1);
});

test('cache: cancelling a booking invalidates the cached date and frees the slot', async () => {
  const booked = await book(api, 'cache-cancel-1');
  const during = await api.get(slotsPath(DATE));
  assert.ok(!during.body.slots.includes(booked.body.slot));

  assert.equal((await api.post(`/appointments/${booked.body.id}/cancel`)).status, 200);

  const after = await api.get(slotsPath(DATE));
  assert.ok(after.body.slots.includes(booked.body.slot), 'the cancelled slot must be offered again');
});

test('cache: a replayed booking does not need to invalidate again, and stays consistent', async () => {
  await book(api, 'cache-replay-1');
  const a = await api.get(slotsPath(DATE));
  await book(api, 'cache-replay-1');
  const b = await api.get(slotsPath(DATE));
  assert.deepEqual(b.body, a.body);
  assert.equal(await slotQueries(), 1);
});
