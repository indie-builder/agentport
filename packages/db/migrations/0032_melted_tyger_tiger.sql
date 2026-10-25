ALTER TABLE "conversations" ADD COLUMN "sdk_session_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "fork_from_sdk_message_uuid" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sdk_message_uuid" text;