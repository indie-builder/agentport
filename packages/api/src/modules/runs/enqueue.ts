import { type Database, schema } from '@agentport/db';
import { and, eq } from 'drizzle-orm';

export async function failQueuedRunEnqueue(db: Database, runId: string): Promise<boolean> {
  const [failed] = await db
    .update(schema.agentRuns)
    .set({
      status: 'failed',
      endedAt: new Date(),
      error: '消息入队失败，请重新发送。',
      errorKind: 'infra',
    })
    .where(and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.status, 'queued')))
    .returning({ id: schema.agentRuns.id });
  return failed !== undefined;
}
