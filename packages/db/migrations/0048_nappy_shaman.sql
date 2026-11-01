ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_trigger_check";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "channel_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "channel_trigger_message_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "channel_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "channel_message_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_channel_trigger_message_id_channel_messages_id_fk" FOREIGN KEY ("channel_trigger_message_id") REFERENCES "public"."channel_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_channel_message_id_channel_messages_id_fk" FOREIGN KEY ("channel_message_id") REFERENCES "public"."channel_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_messages_source_message_idx" ON "channel_messages" USING btree ("source_message_id") WHERE "channel_messages"."source_message_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_channel_agent_idx" ON "conversations" USING btree ("channel_id","agent_id") WHERE "conversations"."channel_id" is not null;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_trigger_check" CHECK ("agent_runs"."trigger" in ('chat', 'mcp', 'schedule', 'event', 'review', 'channel'));