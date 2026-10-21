// A mock SMS provider. Slow (like a real one) and breakable on demand:
//   mode 'ok'     delivers after config.smsLatencyMs
//   mode 'flaky'  the first two attempts fail with 503, then it delivers
//   mode 'down'   every attempt fails with 503
import { sleep } from './sleep.js';

export function createSms({ config }) {
  const state = { mode: 'ok', attempts: 0, flakyFailures: 0, sent: [] };

  return {
    state,
    async send(to, text) {
      state.attempts += 1;
      await sleep(config.smsLatencyMs);
      if (state.mode === 'down' || (state.mode === 'flaky' && state.flakyFailures < 2)) {
        if (state.mode === 'flaky') state.flakyFailures += 1;
        const err = new Error('sms_provider_unavailable');
        err.status = 503;
        throw err;
      }
      state.sent.push({ to, text, at: new Date().toISOString() });
      return { ok: true };
    },
    reset() {
      state.mode = 'ok';
      state.attempts = 0;
      state.flakyFailures = 0;
      state.sent = [];
    },
  };
}
