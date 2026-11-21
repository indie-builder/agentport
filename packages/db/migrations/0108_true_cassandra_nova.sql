DROP INDEX "approval_requests_run_server_tool_idx";--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "decision_hash" text;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_run_server_tool_decision_idx" ON "approval_requests" USING btree ("run_id","server_id","tool_name","decision_hash") WHERE "approval_requests"."superseded_at" is null;