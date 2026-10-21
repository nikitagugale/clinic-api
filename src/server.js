// Starts the clinic API on http://127.0.0.1:4000 (set PORT to change it; PORT=0 picks a free port).
// After you change code, stop the server (Ctrl+C) and start it again: `npm run dev`.
import express from 'express';
import { createApp } from './app.js';
import { config } from './config.js';
import { createDataAccess, openDb } from './db.js';
import { mountLab } from './lab.js';
import { createRedis } from './lib/redis.js';
import { createModel } from './lib/model.js';
import { createSms } from './lib/sms.js';
import { createLogger } from './log.js';

const log = createLogger();
const hooks = { failNextBooking: false };

let database;
try {
  database = await openDb();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const db = createDataAccess({ pg: database.pg, config, hooks });
const deps = { db, redis: createRedis(), sms: createSms({ config }), model: createModel({ config }), config, log, hooks };

function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = err.type === 'entity.parse.failed' ? 400 : (err.status ?? err.statusCode ?? 500);
  const code = err.type === 'entity.parse.failed' ? 'invalid_json' : (err.code && typeof err.code === 'string' && !/^\d/.test(err.code) ? err.code : status >= 500 ? 'internal_error' : 'invalid_request');
  if (status >= 500) log.error('unhandled error', { requestId: req.id, message: err.message });
  res.status(status).json({ error: { code, message: status >= 500 ? 'Something went wrong' : err.message } });
}

const root = express();
root.use(express.json());
mountLab(root, deps);
root.get('/health', (req, res) => res.json({ ok: true }));
root.use(createApp(deps));
root.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` } }));
root.use(errorHandler);

const server = root.listen(config.port, config.host, () => {
  const { port } = server.address();
  console.log(`listening on http://${config.host}:${port}`);
});
server.on('error', err => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${config.port} is already in use. Stop the other server and try again.` : err.message);
  database.close().finally(() => process.exit(1));
});

async function shutdown() {
  server.close();
  await database.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
