// A tiny in-process job queue with the same shape as BullMQ's Queue and Worker, for the subset the lab uses.
// BullMQ itself needs a real Redis server. Production code swaps the import:
//     import { Queue, Worker } from 'bullmq';        // and passes { connection } to both
// and the calls below keep working.
//
//   const queue = new Queue('sms', { connection });
//   await queue.add('send-confirmation', { appointmentId }, {
//     jobId: 'sms-42',                                  // adding the same jobId twice does nothing
//     attempts: 3,                                      // total tries, including the first
//     backoff: { type: 'exponential', delay: 500 },     // waits 500 ms, then 1000 ms, ...
//   });
//   const worker = new Worker('sms', async job => { ...job.data... }, { connection });
//   worker.on('failed', (job, err) => ...);             // after the last attempt
//   worker.on('completed', (job, result) => ...);
//
// Custom job ids follow BullMQ's rules: no colon (it is Redis's key separator) and not made only of digits.
// Use something like 'sms-42'.
//
// Differences from BullMQ you should know about: jobs live in memory and vanish on restart, there is one process,
// and only attempts, backoff, jobId, delay of retries and concurrency are implemented.
import { EventEmitter } from 'node:events';

const queues = new Map();

function registry(name) {
  if (!queues.has(name)) queues.set(name, { jobs: new Map(), workers: new Set(), seq: 0 });
  return queues.get(name);
}

function backoffDelay(job) {
  const b = job.opts.backoff;
  if (!b) return 0;
  const base = typeof b === 'number' ? b : (b.delay ?? 0);
  return typeof b === 'object' && b.type === 'exponential' ? base * 2 ** (job.attemptsMade - 1) : base;
}

export class Queue {
  constructor(name, opts = {}) {
    this.name = name;
    this.opts = opts;
  }

  async add(jobName, data, opts = {}) {
    if (opts.jobId !== undefined) {
      const id = String(opts.jobId);
      if (id.includes(':')) throw new Error('Custom Id cannot contain :');
      if (/^\d+$/.test(id)) throw new Error('Custom Id cannot be integers');
    }
    const q = registry(this.name);
    const id = opts.jobId !== undefined ? String(opts.jobId) : String(++q.seq);
    if (q.jobs.has(id)) return q.jobs.get(id); // same id: not added twice
    const job = {
      id,
      name: jobName,
      data,
      opts: { attempts: 1, ...opts },
      attemptsMade: 0,
      state: 'waiting',
      failedReason: undefined,
      timestamp: Date.now(),
    };
    q.jobs.set(id, job);
    for (const w of q.workers) w._kick();
    return job;
  }

  async getJobs() {
    return [...registry(this.name).jobs.values()];
  }

  async close() {}
}

export class Worker extends EventEmitter {
  constructor(name, processor, opts = {}) {
    super();
    this.name = name;
    this.processor = processor;
    this.concurrency = opts.concurrency ?? 1;
    this.running = 0;
    this.closed = false;
    this.timers = new Set();
    registry(name).workers.add(this);
    setImmediate(() => this._kick());
  }

  _kick() {
    if (this.closed) return;
    for (const job of registry(this.name).jobs.values()) {
      if (this.running >= this.concurrency) break;
      if (job.state === 'waiting') this._run(job);
    }
  }

  async _run(job) {
    job.state = 'active';
    job.attemptsMade += 1;
    this.running += 1;
    try {
      const result = await this.processor(job);
      job.state = 'completed';
      job.returnvalue = result;
      this.emit('completed', job, result);
    } catch (err) {
      job.failedReason = err?.message ?? String(err);
      if (job.attemptsMade < job.opts.attempts) {
        job.state = 'delayed';
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          job.state = 'waiting';
          this._kick();
        }, backoffDelay(job));
        this.timers.add(timer);
      } else {
        job.state = 'failed';
        this.emit('failed', job, err);
      }
    } finally {
      this.running -= 1;
      this._kick();
    }
  }

  async close() {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    registry(this.name).workers.delete(this);
  }
}

// ---- used by the lab's own tooling, not by your code ----
export function resetQueues() {
  for (const q of queues.values()) {
    q.jobs.clear();
    q.seq = 0;
  }
}

export function snapshotQueues() {
  const out = {};
  for (const [name, q] of queues) {
    out[name] = [...q.jobs.values()].map(j => ({ id: j.id, name: j.name, state: j.state, attemptsMade: j.attemptsMade, failedReason: j.failedReason }));
  }
  return out;
}
