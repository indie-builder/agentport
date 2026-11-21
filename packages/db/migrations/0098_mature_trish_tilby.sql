ALTER TABLE "knowledge_jobs" DROP CONSTRAINT "knowledge_jobs_type_check";--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "summary_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "summary_version_id" text;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "summary_generated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "summary_error" text;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_summary_status_check" CHECK ("knowledge_documents"."summary_status" in ('none', 'pending', 'generating', 'ready', 'failed'));--> statement-breakpoint
ALTER TABLE "knowledge_jobs" ADD CONSTRAINT "knowledge_jobs_type_check" CHECK ("knowledge_jobs"."type" in ('ingest', 'reindex', 'sync', 'source_probe', 'wiki_generate', 'summary', 'cleanup'));