// Idempotency for retried POSTs. The first request with a given Idempotency-Key claims it in Redis (atomic SET NX)
// and runs the handler; its response is cached for the TTL. A repeat with the same body gets that response back
// (Idempotency-Replayed: true); a repeat with a different body gets 409. A repeat that arrives while the first is
// still running waits for it, so concurrent retries never run the handler twice.
import crypto from 'node:crypto';
import { sleep } from '../lib/sleep.js';

const apiError = (res, status, code, message) => res.status(status).json({ error: { code, message } });

const POLL_MS = 25;
const DEFAULT_MAX_WAIT_MS = 30000;

export function idempotencyMiddleware(redisClient, { ttlSeconds, maxWaitMs = DEFAULT_MAX_WAIT_MS }) {
  return async (req, res, next) => {
    const clientKey = req.get('Idempotency-Key');
    if (!clientKey || clientKey.trim() === '') {
      return apiError(res, 400, 'idempotency_key_required', 'The Idempotency-Key header is required');
    }

    const hash = crypto.createHash('sha256').update(JSON.stringify(req.body ?? {})).digest('hex');
    const redisKey = `idem:${req.method}:${req.baseUrl}${req.path}:${clientKey}`;
    const pending = JSON.stringify({ hash, state: 'pending' });

    const claimed = await redisClient.set(redisKey, pending, 'EX', ttlSeconds, 'NX');
    if (claimed === 'OK') {
      // We own the key: run the handler and cache what it answers.
      let cached = false;
      const json = res.json.bind(res);
      res.json = body => {
        if (res.statusCode < 500) {
          cached = true;
          // Fire and forget would race a fast retry, so the response is sent once the cache write is done.
          redisClient
            .set(redisKey, JSON.stringify({ hash, state: 'done', status: res.statusCode, body }), 'EX', ttlSeconds)
            .finally(() => json(body));
          return res;
        }
        return json(body);
      };
      // A failed attempt (5xx, thrown error, dropped connection) must not block the client's retry.
      res.on('close', () => {
        if (!cached) redisClient.del(redisKey).catch(() => {});
      });
      return next();
    }

    // Someone already used this key. Wait for an in-flight request to finish, then compare.
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      const raw = await redisClient.get(redisKey);
      if (raw === null) return idempotencyMiddleware(redisClient, { ttlSeconds, maxWaitMs })(req, res, next); // owner failed: try to claim
      const entry = JSON.parse(raw);
      if (entry.hash !== hash) {
        return apiError(res, 409, 'idempotency_key_reuse', 'This Idempotency-Key was already used with a different request body');
      }
      if (entry.state === 'done') {
        res.set('Idempotency-Replayed', 'true');
        return res.status(entry.status).json(entry.body);
      }
      if (Date.now() > deadline) {
        res.set('Retry-After', '1');
        return apiError(res, 409, 'request_in_progress', 'A request with this Idempotency-Key is still in progress; retry shortly');
      }
      await sleep(POLL_MS);
    }
  };
}
