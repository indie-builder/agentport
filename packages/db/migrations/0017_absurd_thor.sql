ALTER TABLE "conversations" ADD COLUMN "last_message_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- 回填真实值，否则所有历史会话都排在同一时刻。
UPDATE "conversations" c SET "last_message_at" = COALESCE(
  (SELECT max(m."created_at") FROM "messages" m WHERE m."conversation_id" = c."id"),
  c."created_at"
);--> statement-breakpoint
CREATE INDEX "agent_runs_running_idx" ON "agent_runs" USING btree ("status") WHERE "agent_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "agent_runs_status_started_idx" ON "agent_runs" USING btree ("status","started_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_servers_server_idx" ON "agent_servers" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "agent_skills_skill_idx" ON "agent_skills" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "audit_log_action_created_idx" ON "audit_log" USING btree ("action" text_pattern_ops,"created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "conversations_last_message_idx" ON "conversations" USING btree ("last_message_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "eval_results_run_case_idx" ON "eval_results" USING btree ("eval_run_id","case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "eval_runs_agent_running_idx" ON "eval_runs" USING btree ("agent_id") WHERE "eval_runs"."status" = 'running';
