CREATE TABLE "memory_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text,
	"target" jsonb NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"source_review_run_id" text,
	"reverses_change_id" text,
	"state" text DEFAULT 'applied' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_reviews" (
	"run_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"request_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"model_agent_id" text NOT NULL,
	"target" jsonb NOT NULL,
	"sources" jsonb NOT NULL,
	"instruction" text DEFAULT '' NOT NULL,
	"before" jsonb NOT NULL,
	"proposal" jsonb,
	"decision" text DEFAULT 'pending' NOT NULL,
	"applied_change_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "output_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"run_id" text NOT NULL,
	"path" text NOT NULL,
	"sha256" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_trigger_check";--> statement-breakpoint
ALTER TABLE "memory_changes" ADD CONSTRAINT "memory_changes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_changes" ADD CONSTRAINT "memory_changes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_changes" ADD CONSTRAINT "memory_changes_source_review_run_id_agent_runs_id_fk" FOREIGN KEY ("source_review_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_reviews" ADD CONSTRAINT "memory_reviews_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_reviews" ADD CONSTRAINT "memory_reviews_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_reviews" ADD CONSTRAINT "memory_reviews_model_agent_id_agents_id_fk" FOREIGN KEY ("model_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "output_shares" ADD CONSTRAINT "output_shares_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_changes_user_created_idx" ON "memory_changes" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_changes_agent_created_idx" ON "memory_changes" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_reviews_user_request_idx" ON "memory_reviews" USING btree ("user_id","request_key");--> statement-breakpoint
CREATE INDEX "output_shares_conversation_idx" ON "output_shares" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "output_shares_token_hash_idx" ON "output_shares" USING btree ("token_hash");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_trigger_check" CHECK ("agent_runs"."trigger" in ('chat', 'mcp', 'schedule', 'event', 'review'));