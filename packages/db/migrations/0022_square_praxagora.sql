ALTER TABLE "eval_results" ADD COLUMN "case_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "case_snapshot" jsonb;