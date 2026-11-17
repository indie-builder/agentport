import { client as sql } from './database.js';

export async function setLastRunAt(scheduleId: string, iso: string): Promise<void> {
  await sql`update agent_schedules set last_run_at = ${iso} where id = ${scheduleId}`;
}

export async function countScheduleRuns(scheduleId: string): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    select count(*)::text as count from agent_runs where schedule_id = ${scheduleId}`;
  return Number(rows[0]?.count ?? 0);
}
