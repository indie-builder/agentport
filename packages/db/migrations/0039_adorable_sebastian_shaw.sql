CREATE TABLE "run_questions" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"request_id" text NOT NULL,
	"tool_use_id" text NOT NULL,
	"questions" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"answers" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"close_reason" text,
	CONSTRAINT "run_questions_status_check" CHECK ("run_questions"."status" in ('pending', 'answered', 'declined', 'closed'))
);
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "permission_mode" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "run_questions" ADD CONSTRAINT "run_questions_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_questions_run_request_idx" ON "run_questions" USING btree ("run_id","request_id");