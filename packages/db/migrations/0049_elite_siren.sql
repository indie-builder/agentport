ALTER TABLE "approval_requests" ADD COLUMN "channel_id" text;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "approved_by_business_id" text;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;