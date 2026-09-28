// Live task_update pushes for status changes the watchdog makes. Mirrors
// workers/delivery/src/notify.ts (same message shape, 410 cleanup, never throws), but
// sends a whole job's updates with one counts query and one connection lookup.
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { eq, sql } from 'drizzle-orm';
import { getDb } from './db.js';
import { tasks, wsConnections } from './schema.js';

export interface TaskUpdate {
  taskId: string;
  fileId?: string;
  fileName?: string | null;
  attemptCount?: number;
  status: string;
  failureReason?: string | null;
}

/** Pushes one `task_update` per update to every connection subscribed to the job. Never throws. */
export async function pushTaskUpdates(jobId: string, updates: TaskUpdate[]): Promise<void> {
  if (updates.length === 0) return;

  const callback = process.env.WS_CALLBACK_URL;
  const pushUrl = process.env.WS_PUSH_URL;
  if (!callback && !pushUrl) {
    console.log(`WebSocket push disabled (WS_CALLBACK_URL not set); skipped ${updates.length} task_update(s) for job ${jobId}`);
    return;
  }

  try {
    const db = await getDb();
    const [rows, connections] = await Promise.all([
      db
        .select({ status: tasks.status, count: sql<number>`count(*)::int` })
        .from(tasks)
        .where(eq(tasks.jobId, jobId))
        .groupBy(tasks.status),
      db
        .select({ connectionId: wsConnections.connectionId })
        .from(wsConnections)
        .where(eq(wsConnections.jobId, jobId)),
    ]);

    const counts = { pending: 0, in_progress: 0, completed: 0, failed: 0 };
    for (const row of rows) {
      if (row.status in counts) counts[row.status as keyof typeof counts] = row.count;
    }

    const messages = updates.map((u) => ({
      type: 'task_update',
      jobId,
      taskId: u.taskId,
      fileId: u.fileId,
      fileName: u.fileName ?? undefined,
      attemptCount: u.attemptCount,
      status: u.status,
      failureReason: u.failureReason ?? undefined,
      counts,
    }));

    if (callback) {
      const client = new ApiGatewayManagementApiClient({ endpoint: callback });

      await Promise.all(connections.map(async ({ connectionId }) => {
        for (const message of messages) {
          try {
            await client.send(new PostToConnectionCommand({
              ConnectionId: connectionId,
              Data: Buffer.from(JSON.stringify(message)),
            }));
          } catch (err) {
            const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
            if (status === 410) {
              // The browser went away without a clean $disconnect: forget it and stop pushing to it.
              await db.delete(wsConnections).where(eq(wsConnections.connectionId, connectionId));
              return;
            }
            console.error('Push failed:', err);
          }
        }
      }));
      return;
    }

    // Local development: the ws dev server relays these to its sockets.
    for (const message of messages) {
      const res = await fetch(pushUrl!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      });
      if (!res.ok && res.status !== 204) {
        console.error(`Push failed: ${res.status}`);
      }
    }
  } catch (err) {
    console.error('Push failed:', err);
  }
}
