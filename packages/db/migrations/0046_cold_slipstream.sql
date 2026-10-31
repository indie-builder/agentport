CREATE TABLE "knowledge_document_source_ranges" (
	"document_id" text NOT NULL,
	"range_id" text NOT NULL,
	CONSTRAINT "knowledge_document_source_ranges_pk" PRIMARY KEY("document_id","range_id")
);
--> statement-breakpoint
CREATE TABLE "knowledge_sync_items" (
	"id" text PRIMARY KEY NOT NULL,
	"sync_run_id" text NOT NULL,
	"source_id" text NOT NULL,
	"range_id" text,
	"external_id" text NOT NULL,
	"document_id" text,
	"status" text NOT NULL,
	"code" text NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"retryable" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_sync_items_status_check" CHECK ("knowledge_sync_items"."status" in ('failed', 'skipped')),
	CONSTRAINT "knowledge_sync_items_message_check" CHECK (char_length("knowledge_sync_items"."message") <= 500)
);
--> statement-breakpoint
ALTER TABLE "knowledge_documents" DROP CONSTRAINT "knowledge_documents_source_type_check";--> statement-breakpoint
ALTER TABLE "knowledge_jobs" DROP CONSTRAINT "knowledge_jobs_type_check";--> statement-breakpoint
ALTER TABLE "knowledge_model_profiles" DROP CONSTRAINT "knowledge_model_profiles_kind_check";--> statement-breakpoint
ALTER TABLE "knowledge_model_profiles" DROP CONSTRAINT "knowledge_model_profiles_dimensions_check";--> statement-breakpoint
ALTER TABLE "knowledge_source_ranges" DROP CONSTRAINT "knowledge_source_ranges_kind_check";--> statement-breakpoint
ALTER TABLE "knowledge_sources" DROP CONSTRAINT "knowledge_sources_type_check";--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD COLUMN "asr_profile_id" text;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN "parent_ordinal" integer;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN "index_role" text DEFAULT 'leaf' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN "locator" jsonb;--> statement-breakpoint
ALTER TABLE "knowledge_document_versions" ADD COLUMN "origin" text DEFAULT 'source' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_document_versions" ADD COLUMN "parent_version_id" text;--> statement-breakpoint
ALTER TABLE "knowledge_document_versions" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_document_versions" ADD COLUMN "faq" jsonb;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "content_kind" text DEFAULT 'document' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "source_connection_id" text;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "disabled_reason" text;--> statement-breakpoint
ALTER TABLE "knowledge_jobs" ADD COLUMN "result" jsonb;--> statement-breakpoint
ALTER TABLE "knowledge_wiki_pages" ADD COLUMN "parent_id" text;--> statement-breakpoint
ALTER TABLE "knowledge_wiki_pages" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_document_source_ranges" ADD CONSTRAINT "knowledge_document_source_ranges_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_document_source_ranges" ADD CONSTRAINT "knowledge_document_source_ranges_range_id_knowledge_source_ranges_id_fk" FOREIGN KEY ("range_id") REFERENCES "public"."knowledge_source_ranges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sync_items" ADD CONSTRAINT "knowledge_sync_items_sync_run_id_knowledge_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."knowledge_sync_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sync_items" ADD CONSTRAINT "knowledge_sync_items_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sync_items" ADD CONSTRAINT "knowledge_sync_items_range_id_knowledge_source_ranges_id_fk" FOREIGN KEY ("range_id") REFERENCES "public"."knowledge_source_ranges"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sync_items" ADD CONSTRAINT "knowledge_sync_items_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_document_source_ranges_range_idx" ON "knowledge_document_source_ranges" USING btree ("range_id");--> statement-breakpoint
CREATE INDEX "knowledge_sync_items_run_idx" ON "knowledge_sync_items" USING btree ("sync_run_id","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_sync_items_source_idx" ON "knowledge_sync_items" USING btree ("source_id","created_at");--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD CONSTRAINT "knowledge_bases_asr_profile_id_knowledge_model_profiles_id_fk" FOREIGN KEY ("asr_profile_id") REFERENCES "public"."knowledge_model_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_document_versions" ADD CONSTRAINT "knowledge_document_versions_parent_version_id_knowledge_document_versions_id_fk" FOREIGN KEY ("parent_version_id") REFERENCES "public"."knowledge_document_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_wiki_pages" ADD CONSTRAINT "knowledge_wiki_pages_parent_id_knowledge_wiki_pages_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."knowledge_wiki_pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_bases_asr_profile_idx" ON "knowledge_bases" USING btree ("asr_profile_id");--> statement-breakpoint
CREATE INDEX "knowledge_document_versions_parent_idx" ON "knowledge_document_versions" USING btree ("parent_version_id");--> statement-breakpoint
CREATE INDEX "knowledge_documents_base_kind_updated_idx" ON "knowledge_documents" USING btree ("base_id","content_kind","updated_at");--> statement-breakpoint
CREATE INDEX "knowledge_documents_source_connection_idx" ON "knowledge_documents" USING btree ("source_connection_id");--> statement-breakpoint
CREATE INDEX "knowledge_wiki_pages_base_parent_idx" ON "knowledge_wiki_pages" USING btree ("base_id","parent_id","position");--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_index_role_check" CHECK ("knowledge_chunks"."index_role" in ('leaf', 'parent'));--> statement-breakpoint
ALTER TABLE "knowledge_document_versions" ADD CONSTRAINT "knowledge_document_versions_origin_check" CHECK ("knowledge_document_versions"."origin" in ('source', 'manual', 'faq', 'wiki'));--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_content_kind_check" CHECK ("knowledge_documents"."content_kind" in ('document', 'faq', 'wiki'));--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_disabled_reason_check" CHECK ("knowledge_documents"."disabled_reason" is null or "knowledge_documents"."disabled_reason" in ('manual', 'source', 'range', 'remote'));--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_source_type_check" CHECK ("knowledge_documents"."source_type" in ('upload', 'url', 'feishu_wiki', 'feishu_drive', 'gitlab', 'github', 'feed', 'manual', 'lark_wiki', 'lark_drive', 'notion', 'confluence', 'yuque', 'dingtalk', 'ima', 'seafile', 'nextcloud'));--> statement-breakpoint
ALTER TABLE "knowledge_jobs" ADD CONSTRAINT "knowledge_jobs_type_check" CHECK ("knowledge_jobs"."type" in ('ingest', 'reindex', 'sync', 'source_probe', 'wiki_generate', 'cleanup'));--> statement-breakpoint
ALTER TABLE "knowledge_model_profiles" ADD CONSTRAINT "knowledge_model_profiles_asr_fields_check" CHECK ("knowledge_model_profiles"."kind" <> 'asr' or ("knowledge_model_profiles"."embedding_protocol" = 'openai' and "knowledge_model_profiles"."image_input_enabled" = false));--> statement-breakpoint
ALTER TABLE "knowledge_model_profiles" ADD CONSTRAINT "knowledge_model_profiles_kind_check" CHECK ("knowledge_model_profiles"."kind" in ('embedding', 'rerank', 'asr'));--> statement-breakpoint
ALTER TABLE "knowledge_model_profiles" ADD CONSTRAINT "knowledge_model_profiles_dimensions_check" CHECK (("knowledge_model_profiles"."kind" = 'embedding' and "knowledge_model_profiles"."dimensions" = 1024) or ("knowledge_model_profiles"."kind" in ('rerank', 'asr') and "knowledge_model_profiles"."dimensions" is null));--> statement-breakpoint
ALTER TABLE "knowledge_source_ranges" ADD CONSTRAINT "knowledge_source_ranges_kind_check" CHECK ("knowledge_source_ranges"."kind" in ('wiki_space', 'wiki_node', 'drive_folder', 'gitlab_project', 'github_repo', 'feed', 'notion_page', 'notion_database', 'notion_data_source', 'confluence_space', 'confluence_page', 'yuque_repo', 'dingtalk_workspace', 'dingtalk_node', 'ima_kb', 'seafile_repo', 'nextcloud_path'));--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_type_check" CHECK ("knowledge_sources"."type" in ('feishu_wiki', 'feishu_drive', 'gitlab', 'github', 'feed', 'lark_wiki', 'lark_drive', 'notion', 'confluence', 'yuque', 'dingtalk', 'ima', 'seafile', 'nextcloud'));