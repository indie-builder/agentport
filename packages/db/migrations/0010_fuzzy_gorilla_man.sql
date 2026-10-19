CREATE TABLE "approval_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"server_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_run_server_tool_idx" ON "approval_requests" USING btree ("run_id","server_id","tool_name");--> statement-breakpoint
-- 废弃：审批改存 approval_requests，agent_runs.approvals 不再写入，仅为兼容旧数据保留。
COMMENT ON COLUMN "agent_runs"."approvals" IS 'deprecated: approvals live in approval_requests';
