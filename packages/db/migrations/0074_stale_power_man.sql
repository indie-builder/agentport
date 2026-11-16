CREATE TABLE "platform_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"retention_run_days" integer DEFAULT 90 NOT NULL,
	"retention_message_days" integer DEFAULT 30 NOT NULL,
	"retention_agent_versions" integer DEFAULT 50 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
