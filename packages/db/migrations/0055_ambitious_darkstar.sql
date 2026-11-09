CREATE TABLE "channel_wakes" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"channel_message_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_wakes_status_check" CHECK ("channel_wakes"."status" in ('pending', 'dispatching', 'enqueued', 'skipped', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "channel_wakes" ADD CONSTRAINT "channel_wakes_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_wakes" ADD CONSTRAINT "channel_wakes_channel_message_id_channel_messages_id_fk" FOREIGN KEY ("channel_message_id") REFERENCES "public"."channel_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_wakes" ADD CONSTRAINT "channel_wakes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_wakes_message_agent_idx" ON "channel_wakes" USING btree ("channel_message_id","agent_id");--> statement-breakpoint
CREATE INDEX "channel_wakes_status_next_idx" ON "channel_wakes" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_channel_trigger_idx" ON "agent_runs" USING btree ("channel_id","channel_trigger_message_id","agent_id") WHERE "agent_runs"."channel_id" is not null;