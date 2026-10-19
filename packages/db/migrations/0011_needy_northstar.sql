-- 历史孤儿行会让加约束失败，先清理再建外键（一次性，按 id 批量）。
DELETE FROM "messages" WHERE "run_id" IS NOT NULL AND "run_id" NOT IN (SELECT "id" FROM "agent_runs");--> statement-breakpoint
DELETE FROM "agent_runs" WHERE "conversation_id" NOT IN (SELECT "id" FROM "conversations");--> statement-breakpoint
DELETE FROM "agent_runs" WHERE "agent_id" NOT IN (SELECT "id" FROM "agents");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;