// `npm run state`: a readable snapshot of what is inside the running service. Needs `npm run dev`.
const base = process.env.API ?? 'http://127.0.0.1:4000';
let s;
try {
  s = await (await fetch(`${base}/_lab/state`)).json();
} catch {
  console.error(`Cannot reach ${base}. Start the server first: npm run dev (in another terminal).`);
  process.exit(2);
}

console.log(`appointments (${s.appointments.length})`);
for (const a of s.appointments) console.log(`  ${a.id}  ${a.patientId}  ${a.slot}  ${a.status}`);

const kinds = {};
for (const e of s.events) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
console.log(`\nevents  ${Object.entries(kinds).map(([k, v]) => `${k}: ${v}`).join('   ') || '(none)'}`);
console.log(`\nSMS     mode ${s.sms.mode}   attempts ${s.sms.attempts}   delivered ${s.sms.sent.length}`);
console.log(`model   mode ${s.model.mode}   calls ${s.model.calls}`);
console.log(`db      slot queries ${s.stats.slotQueries}   booking inserts ${s.stats.bookingInserts}`);

console.log(`\nredis keys (${s.redis.length})`);
for (const k of s.redis) console.log(`  ${k.key}   ttl ${k.ttl}s`);

const q = Object.entries(s.queue);
console.log(`\nqueues (${q.length})`);
for (const [name, jobs] of q) for (const j of jobs) console.log(`  ${name}  job ${j.id}  ${j.state}  attempts ${j.attemptsMade}${j.failedReason ? `  (${j.failedReason})` : ''}`);
