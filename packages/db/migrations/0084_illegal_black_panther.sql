ALTER TABLE "agent_versions" ADD COLUMN "definition" jsonb;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "published_version" integer;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "definition_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "agent_version" integer;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "definition_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "resource_versions" jsonb;