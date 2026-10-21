// A mock model API for the appointment summary. Every failure carries `err.status`, like a real HTTP client's error.
//   mode 'ok'       answers after config.modelLatencyMs
//   mode 'slow'     takes 20 s (a bad day for the provider)
//   mode 'flaky'    the first two calls fail with 503, then it answers
//   mode 'limited'  the first two calls fail with 429, then it answers
//   mode 'bad'      always 400 (our request is invalid: retrying cannot help)
//   mode 'unauth'   always 401 (our key is wrong: retrying cannot help)
// Pass { signal } to cancel a call. The 20 s timer is cleared when the signal aborts.
import { sleep } from './sleep.js';

const fail = (status, message) => Object.assign(new Error(message), { status });

export function createModel({ config }) {
  const state = { mode: 'ok', calls: 0, failures: 0 };

  return {
    state,
    async summarize(appointment, { signal } = {}) {
      state.calls += 1;
      switch (state.mode) {
        case 'slow':
          await sleep(20000, signal);
          break;
        case 'flaky':
        case 'limited':
          await sleep(config.modelLatencyMs, signal);
          if (state.failures < 2) {
            state.failures += 1;
            throw state.mode === 'flaky' ? fail(503, 'model_unavailable') : fail(429, 'rate_limited');
          }
          break;
        case 'bad':
          await sleep(config.modelLatencyMs, signal);
          throw fail(400, 'invalid_request');
        case 'unauth':
          await sleep(config.modelLatencyMs, signal);
          throw fail(401, 'invalid_api_key');
        default:
          await sleep(config.modelLatencyMs, signal);
      }
      return { text: `Routine consultation for ${appointment.patientId} on ${appointment.slot}. (mock summary)` };
    },
    reset() {
      state.mode = 'ok';
      state.calls = 0;
      state.failures = 0;
    },
  };
}
