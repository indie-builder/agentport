CREATE TABLE "agent_workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_workflows" ADD CONSTRAINT "agent_workflows_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_workflows_agent_slug_idx" ON "agent_workflows" USING btree ("agent_id","slug");--> statement-breakpoint
CREATE INDEX "agent_workflows_agent_idx" ON "agent_workflows" USING btree ("agent_id");