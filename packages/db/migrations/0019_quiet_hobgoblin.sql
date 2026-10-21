-- Applied migrations 0011/0017 remain immutable. Deployments blocked before either
-- migration must run the corresponding orphan/duplicate repair before retrying it;
-- a later migration cannot repair an earlier migration that never completed.
LOCK TABLE "eval_results", "eval_runs", "messages" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
-- Keep the newest result for each run/case, then repair only affected aggregates.
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY eval_run_id, case_id ORDER BY created_at DESC, id DESC
  ) AS rn FROM eval_results WHERE case_id IS NOT NULL
), removed AS (
  DELETE FROM eval_results WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
  RETURNING eval_run_id
)
UPDATE eval_runs r SET
  total = (SELECT count(*) FROM eval_results e WHERE e.eval_run_id = r.id AND e.id NOT IN (SELECT id FROM ranked WHERE rn > 1)),
  passed = (SELECT count(*) FROM eval_results e WHERE e.eval_run_id = r.id AND e.passed AND e.id NOT IN (SELECT id FROM ranked WHERE rn > 1))
WHERE r.id IN (SELECT eval_run_id FROM removed);
--> statement-breakpoint
-- Retain the newest running batch; preserve superseded history as failed.
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY agent_id ORDER BY created_at DESC, id DESC
  ) AS rn FROM eval_runs WHERE status = 'running'
)
UPDATE eval_runs SET status = 'failed', finished_at = now(),
  error = 'Reconciled duplicate running evaluation during migration'
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
--> statement-breakpoint
UPDATE messages m SET run_id = NULL
WHERE run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.id = m.run_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "eval_results_run_case_idx" ON "eval_results" ("eval_run_id", "case_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "eval_runs_agent_running_idx" ON "eval_runs" ("agent_id") WHERE status = 'running';
--> statement-breakpoint
ALTER TABLE "eval_results" DROP CONSTRAINT "eval_results_case_id_eval_cases_id_fk";
--> statement-breakpoint
ALTER TABLE "eval_results" ALTER COLUMN "case_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_results" ALTER COLUMN "run_id" DROP NOT NULL;--> statement-breakpoint
UPDATE eval_results e SET run_id = NULL
WHERE run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.id = e.run_id);
--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_case_id_eval_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."eval_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_status_check" CHECK ("agent_runs"."status" in ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'timeout'));--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_permission_mode_check" CHECK ("agents"."permission_mode" in ('dontAsk', 'plan', 'default', 'acceptEdits'));--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_allowed_tools_check" CHECK (jsonb_typeof("agents"."allowed_tools") = 'array' and not jsonb_path_exists("agents"."allowed_tools", '$[*] ? (@.type() != "string")'));--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_status_check" CHECK ("eval_runs"."status" in ('running', 'succeeded', 'failed'));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_role_check" CHECK ("messages"."role" in ('user', 'assistant', 'tool'));--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_kind_check" CHECK ("servers"."kind" in ('stdio', 'http', 'generated'));