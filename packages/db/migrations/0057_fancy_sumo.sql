ALTER TABLE "approval_requests" ADD COLUMN "denied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "denied_by_business_id" text;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decision_check" CHECK (not ("approval_requests"."approved_at" is not null and "approval_requests"."denied_at" is not null));