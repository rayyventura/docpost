import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { eq, sql } from 'drizzle-orm';
import { getDb } from './db.js';
import { tasks, wsConnections } from './schema.js';

export async function pushTaskUpdate(input: {
  jobId: string;
  taskId: string;
  fileId?: string;
  fileName?: string | null;
  attemptCount?: number;
  status: string;
  failureReason?: string | null;
}): Promise<void> {
  try {
    const db = await getDb();
    const [rows, connections] = await Promise.all([
      db
        .select({ status: tasks.status, count: sql<number>`count(*)::int` })
        .from(tasks)
        .where(eq(tasks.jobId, input.jobId))
        .groupBy(tasks.status),
      db
        .select({ connectionId: wsConnections.connectionId })
        .from(wsConnections)
        .where(eq(wsConnections.jobId, input.jobId)),
    ]);

    const counts = { pending: 0, in_progress: 0, completed: 0, failed: 0 };
    for (const row of rows) {
      if (row.status in counts) counts[row.status as keyof typeof counts] = row.count;
    }

    const message = {
      type: 'task_update',
      jobId: input.jobId,
      taskId: input.taskId,
      fileId: input.fileId,
      fileName: input.fileName ?? undefined,
      attemptCount: input.attemptCount,
      status: input.status,
      failureReason: input.failureReason ?? undefined,
      counts,
    };

    const callback = process.env.WS_CALLBACK_URL;
    if (callback) {
      const client = new ApiGatewayManagementApiClient({ endpoint: callback });

      await Promise.all(connections.map(async (connection) => {
        try {
          await client.send(new PostToConnectionCommand({
            ConnectionId: connection.connectionId,
            Data: Buffer.from(JSON.stringify(message)),
          }));
        } catch (err) {
          const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
          if (status === 410) {
            await db.delete(wsConnections).where(eq(wsConnections.connectionId, connection.connectionId));
          } else {
            console.error('Push failed:', err);
          }
        }
      }));
      return;
    }

    const pushUrl = process.env.WS_PUSH_URL;
    if (!pushUrl) return;

    const res = await fetch(pushUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
    if (!res.ok && res.status !== 204) {
      console.error(`Push failed: ${res.status}`);
    }
  } catch (err) {
    console.error('Push failed:', err);
  }
}
