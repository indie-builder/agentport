import { evalResults, evalRuns, newId } from '../../../packages/db/src/index.js';
import { db, client as sql } from './database.js';

interface ResultSeed {
  name: string;
  prompt: string;
  expectation: string;
  passed: boolean;
  output: string;
}

export async function insertRun(
  agentId: string,
  status: 'running' | 'succeeded',
  total: number,
  passed: number,
): Promise<string> {
  const [row] = await db
    .insert(evalRuns)
    .values({
      id: newId('evalRun'),
      agentId,
      status,
      total,
      passed,
      createdBy: 'bootstrap-admin',
      finishedAt: status === 'running' ? null : new Date(),
    })
    .returning({ id: evalRuns.id });
  if (!row) throw new Error('Evaluation fixture did not return its ID');
  return row.id;
}

export async function insertResults(runId: string, rows: ResultSeed[]): Promise<void> {
  const createdAt = Date.now();
  const ids = rows.map(() => newId('evalResult')).sort();
  const values = ids.map((id, index) => {
    const row = rows[index];
    if (row === undefined) throw new Error('Evaluation rows and IDs differ');
    return {
      id,
      evalRunId: runId,
      caseId: null,
      caseSnapshot: {
        id: newId('evalCase'),
        name: row.name,
        prompt: row.prompt,
        expectation: row.expectation,
      },
      passed: row.passed,
      output: row.output,
      createdAt: new Date(createdAt + index),
    };
  });
  if (values.length) await db.insert(evalResults).values(values);
}

export async function insertOversizeResults(runId: string): Promise<void> {
  await insertResults(
    runId,
    Array.from({ length: 501 }, (_, index) => ({
      name: `oversize case ${index + 1}`,
      prompt: `prompt ${index + 1}`,
      expectation: '',
      passed: (index + 1) % 2 === 0,
      output: `output ${index + 1}`,
    })),
  );
}

export async function removeFixture(agentId: string): Promise<void> {
  await sql`delete from audit_log where target = ${agentId} or target in (select id from eval_cases where agent_id = ${agentId})`;
  await sql`delete from agents where id = ${agentId}`;
}
