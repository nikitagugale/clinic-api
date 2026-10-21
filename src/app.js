// The clinic's appointment API. This is the file you will change during the lab.
// As shipped it is the "before": every request does its work exactly once per call, and nothing protects it from retries.
//
//   POST /appointments               book a slot                      { patientId, slot }; the confirmation SMS is queued (src/jobs/sms.js)
//   POST /appointments/:id/cancel    cancel and refund the deposit
//   GET  /appointments/available-slots?date=YYYY-MM-DD
//   GET  /appointments/:id/summary   an AI-written summary of the appointment
//   GET  /intake-notes/similar?note_id=N   the 5 most similar intake notes from other patients
//
// Every route also answers under /v1 (the deck shows both spellings). Errors always use one envelope:
//   { "error": { "code": "invalid_request", "message": "..." } }
import crypto from 'node:crypto';
import express from 'express';
import { iso } from './db.js';
import { createSmsQueue } from './jobs/sms.js';
import { callModelWithRetry } from './services/model-call.js';
import { idempotencyMiddleware } from './middleware/idempotency.js';

const apiError = (res, status, code, message) => res.status(status).json({ error: { code, message } });

function parseBooking(body) {
  const { patientId, slot } = body ?? {};
  if (typeof patientId !== 'string' || patientId.trim() === '') return { ok: false, message: 'patientId is required' };
  if (typeof slot !== 'string' || Number.isNaN(Date.parse(slot))) return { ok: false, message: 'slot must be an ISO date-time' };
  return { ok: true, value: { patientId: patientId.trim(), slot: new Date(slot).toISOString() } };
}

export function createApp({ db, redis, sms, model, config, log }) {
  const app = express();
  app.use(express.json());

  // Every request gets an id, echoed in the X-Request-Id header and in every log line about it.
  app.use((req, res, next) => {
    req.id = req.get('X-Request-Id') ?? crypto.randomUUID();
    res.set('X-Request-Id', req.id);
    log.info('request', { requestId: req.id, method: req.method, path: req.path });
    next();
  });

  // Cache-aside for available slots. Each date has a version number; the cached value lives under a key that includes it.
  // Booking or cancelling bumps the version, so the old entry is never read again. A slow read that started before the
  // bump can only write under the old version, so it cannot bring stale slots back. Redis trouble degrades to the database.
  const slotsVersionKey = date => `slots:version:${date}`;
  const slotsDate = slot => iso(slot).slice(0, 10); // availability is computed per UTC date

  async function invalidateSlots(date, requestId) {
    try {
      await redis.incr(slotsVersionKey(date));
    } catch (err) {
      log.error?.('slots cache invalidation failed', { requestId, date, error: err.message });
    }
  }

  const { enqueueConfirmation } = createSmsQueue({ sms, log });

  const router = express.Router();

  router.post('/appointments', idempotencyMiddleware(redis, { ttlSeconds: config.idempotencyTtlSeconds }), async (req, res) => {
    const parsed = parseBooking(req.body);
    if (!parsed.ok) return apiError(res, 400, 'invalid_request', parsed.message);

    const appointment = await db.createAppointment(parsed.value);
    await invalidateSlots(slotsDate(appointment.slot), req.id);
    // The confirmation SMS goes through a queue: the response does not wait for the provider, and failures retry there.
    // The booking already exists, so a queueing problem is logged, not turned into an error the client would retry.
    await enqueueConfirmation(appointment, req.id).catch(err =>
      log.error('could not queue confirmation sms', { requestId: req.id, appointmentId: appointment.id, message: err.message }));

    log.info('booking created', { requestId: req.id, appointmentId: appointment.id });
    res.status(201).json(appointment);
  });

  router.post('/appointments/:id/cancel', async (req, res) => {
    const id = Number(req.params.id);
    const appointment = Number.isInteger(id) ? await db.cancelAppointment(id) : null;
    if (!appointment) return apiError(res, 404, 'not_found', 'No such appointment');
    await invalidateSlots(slotsDate(appointment.slot), req.id);
    log.info('appointment cancelled', { requestId: req.id, appointmentId: id });
    res.json(appointment);
  });

  router.get('/appointments/available-slots', async (req, res) => {
    const date = String(req.query.date ?? '2026-09-15');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
      return apiError(res, 400, 'invalid_request', 'date must be YYYY-MM-DD');
    }

    let cacheKey = null;
    try {
      const version = (await redis.get(slotsVersionKey(date))) ?? '0';
      cacheKey = `slots:${date}:v${version}`;
      const hit = await redis.get(cacheKey);
      if (hit) {
        res.set('X-Cache', 'HIT');
        return res.json({ date, slots: JSON.parse(hit) });
      }
    } catch (err) {
      cacheKey = null;
      log.error?.('slots cache read failed', { requestId: req.id, date, error: err.message });
    }

    const slots = await db.getAvailableSlots(date);
    if (cacheKey) {
      await redis.set(cacheKey, JSON.stringify(slots), 'EX', config.slotsCacheTtlSeconds).catch(err =>
        log.error?.('slots cache write failed', { requestId: req.id, date, error: err.message }));
    }
    res.set('X-Cache', 'MISS');
    res.json({ date, slots });
  });

  router.get('/appointments/:id/summary', async (req, res) => {
    const id = Number(req.params.id);
    const appointment = Number.isInteger(id) ? await db.getAppointment(id) : null;
    if (!appointment) return apiError(res, 404, 'not_found', 'No such appointment');
    try {
      const result = await callModelWithRetry(signal => model.summarize(appointment, { signal }), {
        timeoutMs: config.modelTimeoutMs,
        retries: config.modelRetries,
      });
      res.json({ id, summary: result.text });
    } catch (err) {
      log.error('model call failed', { requestId: req.id, appointmentId: id, code: err.code, status: err.status, message: err.message });
      if (err.code === 'model_timeout') return apiError(res, 504, 'model_timeout', 'The summary service took too long to answer');
      return apiError(res, 502, 'model_unavailable', 'The summary service is unavailable');
    }
  });

  // The 5 notes most similar to note_id, from other patients. score is the cosine similarity (1 = same direction).
  router.get('/intake-notes/similar', async (req, res) => {
    const raw = String(req.query.note_id ?? '');
    const noteId = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(noteId)) return apiError(res, 400, 'invalid_request', 'note_id must be a positive integer');

    const source = (await db.pg.query('SELECT patient_id, embedding::text AS embedding FROM intake_notes WHERE id = $1', [noteId])).rows[0];
    if (!source) return apiError(res, 404, 'not_found', 'No such intake note');
    if (!source.embedding) return apiError(res, 409, 'not_embedded', 'This note has no embedding yet; run the backfill');

    const { rows } = await db.pg.query(
      `SELECT id, patient_id, note_text, 1 - (embedding <=> $1::vector) AS score
         FROM intake_notes
        WHERE patient_id <> $2 AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT 5`,
      [source.embedding, source.patient_id],
    );
    log.info('similar notes', { requestId: req.id, noteId, results: rows.length });
    res.json({
      noteId,
      results: rows.map(r => ({ id: r.id, patientId: r.patient_id, noteText: r.note_text, score: Number(r.score) })),
    });
  });

  app.use('/', router);
  app.use('/v1', router);
  return app;
}
