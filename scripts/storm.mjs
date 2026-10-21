// `npm run storm`: what a flaky mobile connection really does. It sends the SAME booking, with the SAME
// Idempotency-Key, several times at the same moment, then counts how many appointments exist.
//   npm run storm                      5 requests
//   npm run storm -- --n 10            10 requests
// Needs the server running (`npm run dev`). Exit code 0 only if exactly one appointment was created.
const base = process.env.API ?? 'http://127.0.0.1:4000';
const n = Number(process.argv.includes('--n') ? process.argv[process.argv.indexOf('--n') + 1] : 5);
const key = `storm-${Date.now()}`;
const body = { patientId: 'p_storm', slot: '2026-09-16T10:00:00Z' };

async function appointmentCount() {
  const s = await (await fetch(`${base}/_lab/state`)).json();
  return s.appointments.length;
}

let before;
try {
  before = await appointmentCount();
} catch {
  console.error(`Cannot reach ${base}. Start the server first: npm run dev (in another terminal).`);
  process.exit(2);
}

console.log(`${n} identical requests at the same moment, Idempotency-Key "${key}"\n`);
const t0 = Date.now();
const results = await Promise.all(
  Array.from({ length: n }, async (_, i) => {
    const res = await fetch(`${base}/appointments`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    return { i: i + 1, status: res.status, id: json.id, code: json.error?.code, ms: Date.now() - t0 };
  }),
);
for (const r of results) console.log(`  #${r.i}  ${r.status}  ${r.id !== undefined ? `appointment ${r.id}` : r.code ?? ''}  (${r.ms} ms)`);

await new Promise(r => setTimeout(r, 500));
const created = (await appointmentCount()) - before;
console.log(`\nappointments created: ${created}   (it should be exactly 1)`);
if (created === 1) {
  console.log('OK: one booking, however many times the client asked.');
  process.exit(0);
}
console.log(`PROBLEM: the same request created ${created} appointments.`);
process.exit(1);
