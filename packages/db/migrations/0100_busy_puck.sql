ALTER TABLE "eval_cases" ADD COLUMN "judge_mode" text DEFAULT 'contains' NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_results" ADD COLUMN "judge_reason" text;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_judge_mode_check" CHECK ("eval_cases"."judge_mode" in ('contains', 'llm'));