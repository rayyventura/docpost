import { eq, and, gte, inArray, sql } from 'drizzle-orm';
import { files, tasks } from '../db/schema.js';
import type { getDb } from '../db/index.js';

const MAX_ATTEMPTS = Number(process.env.MAX_RECEIVE_COUNT ?? '3');

type Db = ReturnType<typeof getDb>;

export async function reconcileExhaustedTasks(db: Db, jobId: string): Promise<void> {
  const now = new Date();

  const stuck = await db
    .select({
      id: tasks.id,
      status: tasks.status,
      attemptCount: tasks.attemptCount,
      fileName: files.originalName,
    })
    .from(tasks)
    .innerJoin(files, eq(files.id, tasks.fileId))
    .where(
      and(
        eq(tasks.jobId, jobId),
        inArray(tasks.status, ['pending', 'in_progress']),
        gte(tasks.attemptCount, MAX_ATTEMPTS),
      ),
    );

  for (const task of stuck) {
    const reason = `RETRIES_EXHAUSTED ${JSON.stringify({
      fileName: task.fileName,
      attemptCount: String(task.attemptCount),
      reason: 'the delivery worker stopped after the maximum number of retries',
    })}`;

    await db
      .update(tasks)
      .set({
        status: 'failed',
        failureReason: reason,
        updatedAt: now,
      })
      .where(
        and(
          eq(tasks.id, task.id),
          inArray(tasks.status, ['pending', 'in_progress']),
        ),
      );
  }

  if (stuck.length === 0) return;

  await db.execute(sql`
    UPDATE jobs SET completed_at = now()
    WHERE id = ${jobId}
    AND completed_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM tasks
      WHERE job_id = ${jobId}
      AND status IN ('pending', 'in_progress')
    )
  `);
}
