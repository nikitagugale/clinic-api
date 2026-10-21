// The lab's control panel. Do not edit. It lets you (and the step checks) look inside the running service
// and break its dependencies on purpose. Never ship anything like this.
//
//   GET  /_lab/state                what is in the database, Redis, the queue and the SMS log
//   POST /_lab/reset                back to a clean slate (bookings, cache, queue, modes)
//   POST /_lab/sms    {"mode":"ok"|"flaky"|"down"}
//   POST /_lab/model  {"mode":"ok"|"slow"|"flaky"|"limited"|"bad"|"unauth"}
//   POST /_lab/fail-next-booking    the next database write fails once, with a 503
import { resetQueues, snapshotQueues } from './lib/queue.js';

const SMS_MODES = ['ok', 'flaky', 'down'];
const MODEL_MODES = ['ok', 'slow', 'flaky', 'limited', 'bad', 'unauth'];

export function mountLab(app, { db, redis, sms, model, hooks }) {
  app.get('/_lab/state', async (req, res) => {
    const keys = (await redis.keys('*')).sort();
    const cache = [];
    for (const key of keys) {
      const value = await redis.get(key);
      cache.push({ key, ttl: await redis.ttl(key), value: value && value.length > 300 ? `${value.slice(0, 300)}...` : value });
    }
    res.json({
      appointments: await db.listAppointments(),
      events: await db.listEvents(),
      stats: { ...db.stats },
      sms: { mode: sms.state.mode, attempts: sms.state.attempts, sent: sms.state.sent },
      model: { mode: model.state.mode, calls: model.state.calls },
      redis: cache,
      queue: snapshotQueues(),
    });
  });

  app.post('/_lab/reset', async (req, res) => {
    await db.reset();
    await redis.flushall();
    sms.reset();
    model.reset();
    resetQueues();
    hooks.failNextBooking = false;
    res.json({ ok: true });
  });

  app.post('/_lab/sms', (req, res) => {
    const mode = req.body?.mode;
    if (!SMS_MODES.includes(mode)) return res.status(400).json({ error: { code: 'invalid_request', message: `mode must be one of ${SMS_MODES.join(', ')}` } });
    sms.state.mode = mode;
    sms.state.flakyFailures = 0;
    res.json({ ok: true, mode });
  });

  app.post('/_lab/model', (req, res) => {
    const mode = req.body?.mode;
    if (!MODEL_MODES.includes(mode)) return res.status(400).json({ error: { code: 'invalid_request', message: `mode must be one of ${MODEL_MODES.join(', ')}` } });
    model.state.mode = mode;
    model.state.failures = 0;
    res.json({ ok: true, mode });
  });

  app.post('/_lab/fail-next-booking', (req, res) => {
    hooks.failNextBooking = true;
    res.json({ ok: true });
  });
}
