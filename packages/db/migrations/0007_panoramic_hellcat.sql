ALTER TABLE "conversations" ADD COLUMN "parent_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "branch_of_message_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_parent_id_conversations_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_parent_idx" ON "conversations" USING btree ("parent_id");