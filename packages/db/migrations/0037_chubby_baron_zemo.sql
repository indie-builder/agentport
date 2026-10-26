DROP INDEX "eval_runs_agent_idx";--> statement-breakpoint
CREATE INDEX "eval_runs_agent_created_idx" ON "eval_runs" USING btree ("agent_id","created_at","id");--> statement-breakpoint
CREATE INDEX "eval_runs_created_idx" ON "eval_runs" USING btree ("created_at","id");