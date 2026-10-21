// The confirmation-SMS queue. POST /appointments only enqueues; this worker does the slow, failure-prone send,
// retried on its own so the booking response never waits for the SMS provider.
import { Queue, Worker } from '../lib/queue.js';

export const SMS_QUEUE = 'sms';
const JOB_NAME = 'send-confirmation';
// Total tries including the first, then exponential backoff: 500 ms, 1000 ms, ...
const JOB_OPTIONS = { attempts: 3, backoff: { type: 'exponential', delay: 500 } };

export const confirmationText = ({ appointmentId, slot }) => `Appointment ${appointmentId} confirmed for ${slot}`;

export function createSmsQueue({ sms, log }) {
  const queue = new Queue(SMS_QUEUE);

  const worker = new Worker(SMS_QUEUE, async job => {
    const { appointmentId, patientId, slot, requestId } = job.data;
    log.info('sms attempt', { requestId, appointmentId, jobId: job.id, attempt: job.attemptsMade });
    await sms.send(patientId, confirmationText({ appointmentId, slot }));
  });
  worker.on('completed', job => log.info('sms sent', { requestId: job.data.requestId, appointmentId: job.data.appointmentId, jobId: job.id }));
  worker.on('failed', (job, err) =>
    log.error('sms failed permanently', { requestId: job.data.requestId, appointmentId: job.data.appointmentId, jobId: job.id, attempts: job.attemptsMade, message: err.message }));

  /** Queues the confirmation for an appointment. The jobId makes a second call for the same appointment a no-op. */
  const enqueueConfirmation = (appointment, requestId) =>
    queue.add(JOB_NAME, { appointmentId: appointment.id, patientId: appointment.patientId, slot: appointment.slot, requestId }, {
      jobId: `sms-${appointment.id}`,
      ...JOB_OPTIONS,
    });

  return { queue, worker, enqueueConfirmation };
}
