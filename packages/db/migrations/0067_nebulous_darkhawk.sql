CREATE TABLE "agent_hook_files" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"path" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"executable" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "hooks_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "hooks_config" jsonb;--> statement-breakpoint
ALTER TABLE "agent_hook_files" ADD CONSTRAINT "agent_hook_files_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_hook_files_agent_path_idx" ON "agent_hook_files" USING btree ("agent_id","path");--> statement-breakpoint
CREATE INDEX "agent_hook_files_agent_idx" ON "agent_hook_files" USING btree ("agent_id");