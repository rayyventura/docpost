import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

const JOB_QUEUE_URL = process.env.JOB_QUEUE_URL
  ?? 'http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/docpost-jobs';

const sqs = new SQSClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  ...(process.env.SQS_ENDPOINT && {
    endpoint: process.env.SQS_ENDPOINT,
  }),
});

export { sqs };

export async function publishJobMessage(jobId: string, delaySec: number = 60): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: JOB_QUEUE_URL,
      MessageBody: JSON.stringify({ jobId }),
      DelaySeconds: Math.min(delaySec, 900), // SQS max delay is 900s
    }),
  );
}
