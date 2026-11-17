CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link" text NOT NULL,
	"source_id" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_kind_check" CHECK ("notifications"."kind" in ('approval', 'question', 'run_failed', 'schedule_failed', 'budget_alert'))
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "schedule_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_idx" ON "notifications" USING btree ("business_id","kind","source_id");--> statement-breakpoint
CREATE INDEX "notifications_list_idx" ON "notifications" USING btree ("business_id","created_at","id");--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("business_id","created_at") WHERE "notifications"."read_at" is null;