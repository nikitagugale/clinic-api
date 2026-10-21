// One JSON object per line, so a request id can be grepped end to end.
// Usage: log.info('booking created', { requestId, appointmentId })
export function createLogger(write = line => process.stdout.write(line + '\n')) {
  const emit = (level, msg, fields = {}) => write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }));
  return {
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}
