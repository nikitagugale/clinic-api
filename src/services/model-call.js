// Calls the model API with a timeout per attempt and a bounded, jittered, backed-off retry.
//
// What was wrong with the first version of this helper:
//  - the timeout timer was never cleared, so every call left a live timer behind (and a late rejection);
//  - on timeout the model call was only abandoned, not cancelled: it kept running and kept its resources;
//  - it retried everything except 400, so 401, 403 and 422 (which retrying cannot fix) were retried too;
//  - the backoff had no jitter, so clients that failed together would retry together;
//  - the timeout error had no type, so callers could not tell "too slow" from "broken".
import { sleep } from '../lib/sleep.js';

export class ModelCallError extends Error {
  constructor(code, message, { status, cause } = {}) {
    super(message ?? code, { cause });
    this.name = 'ModelCallError';
    this.code = code; // 'model_timeout' | 'model_unavailable'
    this.status = status;
  }
}

const BASE_BACKOFF_MS = 200;

const isTimeout = err => err instanceof ModelCallError && err.code === 'model_timeout';
// Worth another try: we gave up waiting, the provider is erroring (5xx) or it is rate limiting us (429).
// 400, 401, 403 and 422 mean our request or key is wrong: the same call will fail the same way.
const isRetryable = err => isTimeout(err) || err.status === 429 || (err.status >= 500 && err.status <= 599);

// Full jitter on the upper half: 100-200 ms, then 200-400 ms, then 400-800 ms, ...
const backoffMs = attempt => {
  const ceiling = 2 ** attempt * BASE_BACKOFF_MS;
  return ceiling / 2 + Math.random() * (ceiling / 2);
};

/** One attempt: runs fn(signal), aborts the signal and rejects with model_timeout after timeoutMs. The timer is always cleared. */
async function attemptOnce(fn, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new ModelCallError('model_timeout', `model call exceeded ${timeoutMs} ms`);
      controller.abort(err);
      reject(err);
    }, timeoutMs);
  });
  try {
    // The race also covers a fn that ignores the signal. Its result, if it ever arrives, is dropped.
    return await Promise.race([fn(controller.signal), timedOut]);
  } catch (err) {
    // A call cancelled by our own abort rejects with an AbortError: report it as the timeout it was.
    if (controller.signal.aborted && !isTimeout(err)) throw controller.signal.reason;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {(signal: AbortSignal) => Promise<T>} fn  the model call; it should pass the signal on
 * @param {{ timeoutMs: number, retries: number }} opts  retries = extra attempts after the first
 * @returns {Promise<T>} or throws a ModelCallError ('model_timeout' or 'model_unavailable')
 */
export async function callModelWithRetry(fn, { timeoutMs, retries }) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await attemptOnce(fn, timeoutMs);
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) {
        if (err instanceof ModelCallError) throw err;
        throw new ModelCallError('model_unavailable', err?.message, { status: err?.status, cause: err });
      }
      await sleep(backoffMs(attempt));
    }
  }
}
