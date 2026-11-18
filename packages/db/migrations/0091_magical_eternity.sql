CREATE TABLE "run_instructions" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"channel_message_id" text NOT NULL,
	"body" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "channel_messages" ADD COLUMN "attachments" jsonb;--> statement-breakpoint
ALTER TABLE "run_instructions" ADD CONSTRAINT "run_instructions_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_instructions" ADD CONSTRAINT "run_instructions_channel_message_id_channel_messages_id_fk" FOREIGN KEY ("channel_message_id") REFERENCES "public"."channel_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_instructions_run_message_idx" ON "run_instructions" USING btree ("run_id","channel_message_id") WHERE "run_instructions"."channel_message_id" is not null;--> statement-breakpoint
CREATE INDEX "run_instructions_run_delivered_idx" ON "run_instructions" USING btree ("run_id","delivered_at");