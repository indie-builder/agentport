DROP INDEX "channel_wakes_message_agent_idx";--> statement-breakpoint
CREATE INDEX "channel_wakes_message_agent_idx" ON "channel_wakes" USING btree ("channel_message_id","agent_id");