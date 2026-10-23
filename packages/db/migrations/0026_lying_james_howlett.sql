CREATE TABLE "agent_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"name" text NOT NULL,
	"cron" text NOT NULL,
	"prompt" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "trigger" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "agent_version" integer;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "last_tested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "last_test_ok" boolean;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "last_tool_count" integer;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD CONSTRAINT "agent_schedules_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_schedules_due_idx" ON "agent_schedules" USING btree ("next_due_at") WHERE "agent_schedules"."enabled" = true;--> statement-breakpoint
CREATE INDEX "agent_schedules_agent_idx" ON "agent_schedules" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_runs_trigger_idx" ON "agent_runs" USING btree ("trigger");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_trigger_check" CHECK ("agent_runs"."trigger" in ('chat', 'mcp', 'schedule', 'event'));