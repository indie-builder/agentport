CREATE TABLE "agent_output_styles" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"keep_coding_instructions" boolean DEFAULT false NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"is_selected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_output_styles" ADD CONSTRAINT "agent_output_styles_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_output_styles_agent_slug_idx" ON "agent_output_styles" USING btree ("agent_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_output_styles_selected_idx" ON "agent_output_styles" USING btree ("agent_id") WHERE "agent_output_styles"."is_selected" = true;