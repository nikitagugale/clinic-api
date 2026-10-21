# Clinic API: notes for Claude Code

A small Express 5 service (plain JavaScript, ES modules, Node 20+) for a clinic's appointment bookings.
Read this first. It is the project's context file.

## Stack, and what stands in for what
- **Postgres** is PGlite (real Postgres compiled to WebAssembly) with the pgvector extension. Use `db.pg.query(sql, params)`.
  Data access helpers are on `db` (`createAppointment`, `getAvailableSlots`, `cancelAppointment`, ...). Use them; do not write a new database layer.
- **Redis** is `ioredis-mock`, the same API as `ioredis`. The client is `redis` (also called `redisClient` in the lab prompts).
  Stick to the everyday commands: get, set (with an expiry), del, ttl, incr. Never `new Redis(...)` yourself.
- **Queue**: `src/lib/queue.js` exports `Queue` and `Worker` with the same shape as BullMQ. Do not install `bullmq`: it needs a real Redis server.
  Custom job ids follow BullMQ's rules: no colon, and not only digits (use something like `sms-42`).
- **SMS** and **model** are mocks you call through `sms.send(to, text)` and `model.summarize(appointment, { signal })`.
- **No new dependencies.** Everything you need is already installed.

## How the code is organised
- `src/app.js` is where the routes live: `createApp({ db, redis, sms, model, config, log })`. Keep that signature.
- Put new middleware in `src/middleware/`, background workers in `src/jobs/`, SQL files in `migrations/`, one-off scripts in `scripts/`.
- Do **not** edit `src/db.js`, `src/lab.js`, `src/server.js`, `src/config.js` or `src/lib/*` unless the user's prompt says to. They are the lab's fixtures.

## Contracts the tests rely on (never rename)
- Routes: `POST /appointments`, `POST /appointments/:id/cancel`, `GET /appointments/available-slots?date=`, `GET /appointments/:id/summary`. They also answer under `/v1`.
- Errors always use one envelope: `{ "error": { "code": "snake_case", "message": "..." } }`.
- The confirmation SMS text is exactly `Appointment <id> confirmed for <slot>`. Keep it.
- Every request has `req.id` (also the `X-Request-Id` header). Log with `log.info(msg, { requestId: req.id, ... })`.
- Read tunables from `config` (timeouts, TTLs, retry counts). Never hard-code them: the checks change them through the environment.

## Rules for this session
- Do not run `npm run dev`. It never exits and will hang your tool call. Ask the user to start and restart the service.
- After you change code the user must restart the server (Ctrl+C, then `npm run dev`).
- Do not edit `tests/baseline/` or `tests/helpers/`. New tests go in `tests/learner/` and use `tests/helpers/harness.js`.
- Run `npm test` before you say you are done. It must stay green.
