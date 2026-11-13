ALTER TABLE "audit_log" ADD COLUMN "chain_seq" bigserial NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "prev_hash" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "hash" text;--> statement-breakpoint
CREATE INDEX "audit_log_chain_seq_idx" ON "audit_log" USING btree ("chain_seq");