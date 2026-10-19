ALTER TABLE "agent_runs" ADD COLUMN "latency_ms" integer;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "input_tokens" integer;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "output_tokens" integer;