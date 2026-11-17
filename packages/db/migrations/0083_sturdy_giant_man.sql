CREATE TABLE "run_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"run_id" text NOT NULL,
	"message_id" text,
	"output_path" text,
	"output_sha256" text,
	"decision" text NOT NULL,
	"rating" smallint,
	"comment" text DEFAULT '' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"eval_case_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_feedback_decision_check" CHECK ("run_feedback"."decision" in ('accepted', 'rejected')),
	CONSTRAINT "run_feedback_rating_check" CHECK ("run_feedback"."rating" is null or ("run_feedback"."rating" >= 1 and "run_feedback"."rating" <= 5)),
	CONSTRAINT "run_feedback_output_version_check" CHECK (("run_feedback"."output_path" is null) = ("run_feedback"."output_sha256" is null))
);
--> statement-breakpoint
ALTER TABLE "run_feedback" ADD CONSTRAINT "run_feedback_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_feedback" ADD CONSTRAINT "run_feedback_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_feedback" ADD CONSTRAINT "run_feedback_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_feedback" ADD CONSTRAINT "run_feedback_eval_case_id_eval_cases_id_fk" FOREIGN KEY ("eval_case_id") REFERENCES "public"."eval_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_feedback_run_created_idx" ON "run_feedback" USING btree ("run_id","created_at","id");--> statement-breakpoint
CREATE INDEX "run_feedback_eval_case_idx" ON "run_feedback" USING btree ("eval_case_id") WHERE "run_feedback"."eval_case_id" is not null;