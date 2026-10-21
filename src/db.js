// The database: real Postgres (PGlite, Postgres compiled to WebAssembly) with the pgvector extension available.
// Nothing to install. In production the same SQL runs on Azure Database for PostgreSQL (flexible server) with pgvector.
//
// Use it like this:
//   const { pg, close } = await openDb();           // applies migrations/*.sql in order, once each
//   const { rows } = await pg.query('SELECT ...', [params]);
//
// PGlite is a single-process database. Only one process may open a data folder at a time, so stop the server
// before you run `npm run migrate` or `npm run backfill`. A lock file enforces that.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { config } from './config.js';
import { sleep } from './lib/sleep.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = path.join(ROOT, 'migrations');

const BASE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS appointments (
    id SERIAL PRIMARY KEY,
    patient_id TEXT NOT NULL,
    slot TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'booked',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS appointment_events (
    id SERIAL PRIMARY KEY,
    appointment_id INT NOT NULL,
    kind TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS intake_notes (
    id SERIAL PRIMARY KEY,
    patient_id TEXT NOT NULL,
    note_text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

// Fictional intake notes. Not real patient data.
export const SEED_NOTES = [
  ['p_201', 'Patient reports chest pain radiating to the left arm, worse on exertion, with shortness of breath.'],
  ['p_202', 'Persistent dry cough for three weeks with mild fever and night sweats.'],
  ['p_203', 'Severe headache with sensitivity to light and nausea, history of migraine.'],
  ['p_204', 'Chest tightness on climbing stairs, relieved by rest, no fever.'],
  ['p_205', 'Shortness of breath and chest pain when walking uphill, father had a heart attack.'],
  ['p_206', 'Lower back pain after lifting, no numbness, pain worse when bending.'],
  ['p_207', 'Itchy skin rash on both forearms, appeared after starting a new medication.'],
  ['p_208', 'Dry cough and fever for five days, sore throat and fatigue.'],
  ['p_209', 'Migraine with aura, sensitivity to light and vomiting, similar episodes last year.'],
  ['p_201', 'Follow-up for chest pain, ECG normal, advised to avoid heavy exertion.'],
  ['p_210', 'Knee pain and swelling after a fall, difficulty bending the leg.'],
  ['p_211', 'Cough with night sweats and weight loss over two months.'],
];

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function acquireLock(dir) {
  const lockPath = `${dir}.lock`;
  mkdirSync(path.dirname(lockPath), { recursive: true });
  if (existsSync(lockPath)) {
    const pid = Number(readFileSync(lockPath, 'utf8'));
    if (pid && pid !== process.pid && pidAlive(pid)) {
      throw new Error(`The database folder is in use by another process (pid ${pid}). Stop the server first (Ctrl+C in the terminal running \`npm run dev\`), then run this again.`);
    }
    rmSync(lockPath, { force: true }); // stale lock from a crashed process
  }
  writeFileSync(lockPath, String(process.pid));
  return () => rmSync(lockPath, { force: true });
}

export async function openDb({ dataDir = config.dataDir } = {}) {
  const inMemory = dataDir.startsWith('memory://');
  const dir = inMemory ? null : path.resolve(ROOT, dataDir);
  const release = inMemory ? () => {} : acquireLock(dir);
  if (dir) mkdirSync(path.dirname(dir), { recursive: true });

  const pg = new PGlite(inMemory ? 'memory://' : dir, { extensions: { vector } });
  await pg.waitReady;
  await pg.exec(BASE_SCHEMA);

  const seeded = (await pg.query('SELECT count(*)::int AS n FROM intake_notes')).rows[0].n;
  if (seeded === 0) {
    for (const [patientId, text] of SEED_NOTES) {
      await pg.query('INSERT INTO intake_notes (patient_id, note_text) VALUES ($1, $2)', [patientId, text]);
    }
  }

  const applied = await applyMigrations(pg);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await pg.close();
    release();
  };
  process.once('exit', release);
  return { pg, close, applied };
}

async function applyMigrations(pg) {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  const done = new Set((await pg.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
  const applied = [];
  for (const file of readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    await pg.exec(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    await pg.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    applied.push(file);
  }
  return applied;
}

// ---------------------------------------------------------------------------------------------------------------
// Data access for the clinic service. The latencies are simulated so that races and caches are visible.
// `stats` counts what the checks need to see from outside the process.
export const SLOT_TIMES = ['09:00', '10:00', '11:00', '14:00', '15:00', '16:00'];

export const iso = d => new Date(d).toISOString().replace('.000Z', 'Z');

const toAppointment = r => ({ id: r.id, patientId: r.patient_id, slot: iso(r.slot), status: r.status });

export function createDataAccess({ pg, config: cfg = config, hooks = {} }) {
  const stats = { slotQueries: 0, bookingInserts: 0 };

  return {
    pg,
    stats,

    async createAppointment({ patientId, slot }) {
      await sleep(cfg.bookingLatencyMs);
      if (hooks.failNextBooking) {
        hooks.failNextBooking = false;
        const err = new Error('database_unavailable');
        err.status = 503;
        throw err;
      }
      const { rows } = await pg.query('INSERT INTO appointments (patient_id, slot) VALUES ($1, $2::timestamptz) RETURNING *', [patientId, slot]);
      await pg.query("INSERT INTO appointment_events (appointment_id, kind) VALUES ($1, 'booked')", [rows[0].id]);
      stats.bookingInserts += 1;
      return toAppointment(rows[0]);
    },

    async getAppointment(id) {
      const { rows } = await pg.query('SELECT * FROM appointments WHERE id = $1', [id]);
      return rows[0] ? toAppointment(rows[0]) : null;
    },

    /** The slots still free on `date` (YYYY-MM-DD). One database query: slow on purpose. */
    async getAvailableSlots(date) {
      stats.slotQueries += 1;
      await sleep(cfg.slotsLatencyMs);
      const { rows } = await pg.query("SELECT slot FROM appointments WHERE status = 'booked' AND (slot AT TIME ZONE 'UTC')::date = $1::date", [date]);
      const booked = new Set(rows.map(r => iso(r.slot)));
      return SLOT_TIMES.map(t => `${date}T${t}:00Z`).filter(s => !booked.has(s));
    },

    /** Cancels an appointment and refunds the deposit. As shipped, every call refunds again. */
    async cancelAppointment(id) {
      const { rows } = await pg.query("UPDATE appointments SET status = 'cancelled' WHERE id = $1 RETURNING *", [id]);
      if (!rows[0]) return null;
      await pg.query("INSERT INTO appointment_events (appointment_id, kind) VALUES ($1, 'cancelled')", [id]);
      await pg.query("INSERT INTO appointment_events (appointment_id, kind) VALUES ($1, 'deposit_refunded')", [id]);
      return toAppointment(rows[0]);
    },

    async listAppointments() {
      return (await pg.query('SELECT * FROM appointments ORDER BY id')).rows.map(toAppointment);
    },

    async listEvents() {
      return (await pg.query('SELECT appointment_id AS "appointmentId", kind FROM appointment_events ORDER BY id')).rows;
    },

    async getNote(id) {
      const { rows } = await pg.query('SELECT id, patient_id AS "patientId", note_text AS "noteText" FROM intake_notes WHERE id = $1', [id]);
      return rows[0] ?? null;
    },

    /** Clears the booking tables (not the intake notes, which carry the demo's migration and backfill). */
    async reset() {
      await pg.exec('TRUNCATE appointments, appointment_events RESTART IDENTITY');
      stats.slotQueries = 0;
      stats.bookingInserts = 0;
    },
  };
}
