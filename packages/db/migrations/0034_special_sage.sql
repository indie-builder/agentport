ALTER TABLE "messages" ADD COLUMN "ui_format" text DEFAULT 'markdown' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "ui_program" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "ui_state" jsonb;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_ui_format_check" CHECK ("messages"."ui_format" in ('markdown', 'openui'));