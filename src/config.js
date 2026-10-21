// All tunables, read once from the environment. The lab's checks set these to small values so they run fast.
// Code you write should read its timeouts, TTLs and retry counts from here, never hard-code them.
const int = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : Number(v);
};

export const config = {
  port: int('PORT', 4000),
  host: '127.0.0.1',
  // 'memory://' keeps the database in RAM. The default is a folder, so data survives a restart like real Postgres.
  dataDir: process.env.DATA_DIR ?? '.data/pg',

  // Simulated costs of the outside world. Real systems have these too.
  bookingLatencyMs: int('BOOKING_LATENCY_MS', 300), // a database write under load
  slotsLatencyMs: int('SLOTS_LATENCY_MS', 400), // the availability query
  smsLatencyMs: int('SMS_LATENCY_MS', 2000), // the SMS provider
  modelLatencyMs: int('MODEL_LATENCY_MS', 200), // the model API

  // Policy knobs your code should use.
  idempotencyTtlSeconds: int('IDEMPOTENCY_TTL_SECONDS', 86400), // 24 h: the mobile client's real retry window
  slotsCacheTtlSeconds: int('SLOTS_CACHE_TTL_SECONDS', 30),
  modelTimeoutMs: int('MODEL_TIMEOUT_MS', 8000),
  modelRetries: int('MODEL_RETRIES', 2),
};
