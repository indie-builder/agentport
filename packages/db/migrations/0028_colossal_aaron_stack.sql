CREATE TABLE "agent_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"slug" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"globs" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_rules" ADD CONSTRAINT "agent_rules_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_rules_agent_slug_idx" ON "agent_rules" USING btree ("agent_id","slug");--> statement-breakpoint
CREATE INDEX "agent_rules_agent_idx" ON "agent_rules" USING btree ("agent_id");