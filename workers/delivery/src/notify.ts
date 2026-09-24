import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { eq, sql } from 'drizzle-orm';
import { getDb } from './db.js';
import { tasks, wsConnections } from './schema.js';

export async function pushTaskUpdate(input: {
  jobId: string;
  taskId: string;
  status: string;
  failureReason?: string | null;
}): Promise<void> {
  try {
    const db = getDb();
    const rows = await db
      .select({ status: tasks.status, count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(eq(tasks.jobId, input.jobId))
      .groupBy(tasks.status);

    const counts = { pending: 0, in_progress: 0, completed: 0, failed: 0 };
    for (const row of rows) {
      if (row.status in counts) counts[row.status as keyof typeof counts] = row.count;
    }

    const message = {
      type: 'task_update',
      jobId: input.jobId,
      taskId: input.taskId,
      status: input.status,
      failureReason: input.failureReason ?? undefined,
      counts,
    };

    const callback = process.env.WS_CALLBACK_URL;
    if (callback) {
      const client = new ApiGatewayManagementApiClient({ endpoint: callback });
      const connections = await db
        .select({ connectionId: wsConnections.connectionId })
        .from(wsConnections)
        .where(eq(wsConnections.jobId, input.jobId));

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

    const pushUrl = process.env.WS_PUSH_URL ?? 'http://localhost:3004/push';
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
