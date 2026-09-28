import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';

/** SendMessageBatch accepts at most 10 entries per call. */
const BATCH_SIZE = 10;
/** Total SendMessageBatch attempts for entries SQS reports in `Failed`. */
const MAX_SEND_ATTEMPTS = 3;
const RETRY_DELAY_MS = 50;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Enqueues one `{taskId}` delivery message per task. Entries SQS reports in `Failed` are
 * re-sent (bounded); if any are still failing the function throws, so the caller's SQS
 * message is not acked and its redelivery re-queues whatever is still pending. Duplicate
 * task messages are harmless: the delivery worker claims tasks conditionally.
 */
export async function enqueueTasks(sqs: SQSClient, queueUrl: string, taskIds: string[]): Promise<void> {
  for (let i = 0; i < taskIds.length; i += BATCH_SIZE) {
    let entries = taskIds.slice(i, i + BATCH_SIZE).map((taskId, idx) => ({
      Id: String(idx),
      MessageBody: JSON.stringify({ taskId }),
    }));

    for (let attempt = 1; entries.length > 0; attempt++) {
      const result = await sqs.send(new SendMessageBatchCommand({ QueueUrl: queueUrl, Entries: entries }));
      const failed = result?.Failed ?? [];
      if (failed.length === 0) break;

      const failedIds = new Set(failed.map((f) => f.Id));
      entries = entries.filter((e) => failedIds.has(e.Id));
      const detail = failed.map((f) => `${f.Id}:${f.Code ?? 'unknown'}${f.SenderFault ? ' (sender fault)' : ''}`).join(', ');

      if (attempt >= MAX_SEND_ATTEMPTS) {
        throw new Error(`SendMessageBatch left ${entries.length} task message(s) unsent after ${attempt} attempts: ${detail}`);
      }
      console.error(`SendMessageBatch attempt ${attempt} failed for ${entries.length} entr(ies): ${detail}; retrying`);
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }
}
