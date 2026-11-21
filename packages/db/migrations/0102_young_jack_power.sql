ALTER TABLE "eval_cases" ADD COLUMN "expected_tools" jsonb;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD COLUMN "forbidden_tools" jsonb;