ALTER TABLE "agent_runs" ADD COLUMN "approvals" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "api_tools" ADD COLUMN "requires_approval" boolean DEFAULT false NOT NULL;