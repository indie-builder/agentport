ALTER TABLE "approval_requests" ALTER COLUMN "run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "conversation_id" text;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "message_id" text;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_openui_idx" ON "approval_requests" USING btree ("conversation_id","server_id","tool_name") WHERE "approval_requests"."run_id" is null;--> statement-breakpoint
CREATE INDEX "approval_requests_conversation_idx" ON "approval_requests" USING btree ("conversation_id") WHERE "approval_requests"."run_id" is null;