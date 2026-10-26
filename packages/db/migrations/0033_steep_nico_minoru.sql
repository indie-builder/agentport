-- pgvector: drizzle 无法声明扩展与 HNSW opclass，这两段是手工补的。
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "knowledge_bases" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"server_id" text NOT NULL,
	"embedding_profile_id" text NOT NULL,
	"rerank_profile_id" text,
	"settings" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_bases_status_check" CHECK ("knowledge_bases"."status" in ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"base_id" text NOT NULL,
	"document_id" text NOT NULL,
	"version_id" text NOT NULL,
	"folder_id" text,
	"ordinal" integer NOT NULL,
	"kind" text DEFAULT 'text' NOT NULL,
	"heading" text,
	"content" text DEFAULT '' NOT NULL,
	"search_text" text DEFAULT '' NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED,
	"embedding" vector(1024),
	"enabled" boolean DEFAULT true NOT NULL,
	"edited_by_user" boolean DEFAULT false NOT NULL,
	"page_from" integer,
	"page_to" integer,
	"token_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_chunks_kind_check" CHECK ("knowledge_chunks"."kind" in ('text', 'table', 'image'))
);
--> statement-breakpoint
CREATE TABLE "knowledge_document_tags" (
	"document_id" text NOT NULL,
	"tag_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_document_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"version" integer NOT NULL,
	"blob_sha256" text NOT NULL,
	"markdown_sha256" text NOT NULL,
	"original_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"source_revision" text,
	"parse_status" text NOT NULL,
	"page_map" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"embedding_profile_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_document_versions_parse_status_check" CHECK ("knowledge_document_versions"."parse_status" in ('parsed', 'parse_failed'))
);
--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"base_id" text NOT NULL,
	"folder_id" text,
	"title" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text,
	"source_url" text,
	"source_path" text,
	"mime_type" text NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"current_version_id" text,
	"content_hash" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_documents_source_type_check" CHECK ("knowledge_documents"."source_type" in ('upload', 'url', 'feishu_wiki', 'feishu_drive', 'gitlab', 'feed', 'manual')),
	CONSTRAINT "knowledge_documents_status_check" CHECK ("knowledge_documents"."status" in ('pending', 'processing', 'ready', 'failed', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "knowledge_folders" (
	"id" text PRIMARY KEY NOT NULL,
	"base_id" text NOT NULL,
	"parent_id" text,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"base_id" text,
	"document_id" text,
	"source_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"step" text,
	"progress" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	CONSTRAINT "knowledge_jobs_type_check" CHECK ("knowledge_jobs"."type" in ('ingest', 'reindex', 'sync', 'wiki_generate', 'cleanup')),
	CONSTRAINT "knowledge_jobs_status_check" CHECK ("knowledge_jobs"."status" in ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "knowledge_model_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"endpoint_url" text NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer,
	"secrets_encrypted" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_model_profiles_kind_check" CHECK ("knowledge_model_profiles"."kind" in ('embedding', 'rerank')),
	CONSTRAINT "knowledge_model_profiles_dimensions_check" CHECK (("knowledge_model_profiles"."kind" = 'embedding' and "knowledge_model_profiles"."dimensions" = 1024) or ("knowledge_model_profiles"."kind" = 'rerank' and "knowledge_model_profiles"."dimensions" is null))
);
--> statement-breakpoint
CREATE TABLE "knowledge_source_ranges" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"ref" text,
	"paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "knowledge_source_ranges_kind_check" CHECK ("knowledge_source_ranges"."kind" in ('wiki_space', 'wiki_node', 'drive_folder', 'gitlab_project', 'feed'))
);
--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"base_id" text NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets_encrypted" text,
	"status" text DEFAULT 'active' NOT NULL,
	"sync_cron" text,
	"cursor" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_sync_status" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_sources_type_check" CHECK ("knowledge_sources"."type" in ('feishu_wiki', 'feishu_drive', 'gitlab', 'feed')),
	CONSTRAINT "knowledge_sources_status_check" CHECK ("knowledge_sources"."status" in ('active', 'paused', 'auth_error', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "knowledge_sync_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"cursor_before" jsonb,
	"cursor_after" jsonb,
	"stats" jsonb DEFAULT '{"listed":0,"created":0,"updated":0,"disabled":0,"failed":0}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_sync_runs_status_check" CHECK ("knowledge_sync_runs"."status" in ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "knowledge_tags" (
	"id" text PRIMARY KEY NOT NULL,
	"base_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_wiki_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"base_id" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_version_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_wiki_pages_status_check" CHECK ("knowledge_wiki_pages"."status" in ('draft', 'published', 'stale', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "knowledge_wiki_sources" (
	"page_id" text NOT NULL,
	"document_id" text,
	"version_id" text,
	"chunk_id" text,
	"stale" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_wiki_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"version" integer NOT NULL,
	"markdown" text NOT NULL,
	"source_chunk_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text NOT NULL,
	"generated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_wiki_versions_generated_by_check" CHECK ("knowledge_wiki_versions"."generated_by" in ('sdk', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "servers" DROP CONSTRAINT "servers_kind_check";--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD CONSTRAINT "knowledge_bases_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD CONSTRAINT "knowledge_bases_embedding_profile_id_knowledge_model_profiles_id_fk" FOREIGN KEY ("embedding_profile_id") REFERENCES "public"."knowledge_model_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD CONSTRAINT "knowledge_bases_rerank_profile_id_knowledge_model_profiles_id_fk" FOREIGN KEY ("rerank_profile_id") REFERENCES "public"."knowledge_model_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_base_id_knowledge_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_version_id_knowledge_document_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."knowledge_document_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_folder_id_knowledge_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."knowledge_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_document_tags" ADD CONSTRAINT "knowledge_document_tags_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_document_tags" ADD CONSTRAINT "knowledge_document_tags_tag_id_knowledge_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."knowledge_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_document_versions" ADD CONSTRAINT "knowledge_document_versions_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_document_versions" ADD CONSTRAINT "knowledge_document_versions_embedding_profile_id_knowledge_model_profiles_id_fk" FOREIGN KEY ("embedding_profile_id") REFERENCES "public"."knowledge_model_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_base_id_knowledge_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_folder_id_knowledge_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."knowledge_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_folders" ADD CONSTRAINT "knowledge_folders_base_id_knowledge_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_folders" ADD CONSTRAINT "knowledge_folders_parent_id_knowledge_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."knowledge_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_jobs" ADD CONSTRAINT "knowledge_jobs_base_id_knowledge_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_jobs" ADD CONSTRAINT "knowledge_jobs_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_jobs" ADD CONSTRAINT "knowledge_jobs_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_source_ranges" ADD CONSTRAINT "knowledge_source_ranges_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_base_id_knowledge_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sync_runs" ADD CONSTRAINT "knowledge_sync_runs_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_tags" ADD CONSTRAINT "knowledge_tags_base_id_knowledge_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_wiki_pages" ADD CONSTRAINT "knowledge_wiki_pages_base_id_knowledge_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_wiki_sources" ADD CONSTRAINT "knowledge_wiki_sources_page_id_knowledge_wiki_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."knowledge_wiki_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_wiki_sources" ADD CONSTRAINT "knowledge_wiki_sources_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_wiki_sources" ADD CONSTRAINT "knowledge_wiki_sources_version_id_knowledge_document_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."knowledge_document_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_wiki_sources" ADD CONSTRAINT "knowledge_wiki_sources_chunk_id_knowledge_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."knowledge_chunks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_wiki_versions" ADD CONSTRAINT "knowledge_wiki_versions_page_id_knowledge_wiki_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."knowledge_wiki_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_bases_slug_idx" ON "knowledge_bases" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_bases_server_idx" ON "knowledge_bases" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_chunks_version_ordinal_idx" ON "knowledge_chunks" USING btree ("version_id","ordinal");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_search_idx" ON "knowledge_chunks" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_base_document_idx" ON "knowledge_chunks" USING btree ("base_id","document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_document_tags_pk" ON "knowledge_document_tags" USING btree ("document_id","tag_id");--> statement-breakpoint
CREATE INDEX "knowledge_document_tags_tag_idx" ON "knowledge_document_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_document_versions_document_version_idx" ON "knowledge_document_versions" USING btree ("document_id","version");--> statement-breakpoint
CREATE INDEX "knowledge_document_versions_blob_idx" ON "knowledge_document_versions" USING btree ("blob_sha256");--> statement-breakpoint
CREATE INDEX "knowledge_documents_base_status_idx" ON "knowledge_documents" USING btree ("base_id","status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "knowledge_documents_base_folder_idx" ON "knowledge_documents" USING btree ("base_id","folder_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_documents_source_idx" ON "knowledge_documents" USING btree ("base_id","source_type","source_id") WHERE "knowledge_documents"."source_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_folders_base_path_idx" ON "knowledge_folders" USING btree ("base_id","path");--> statement-breakpoint
CREATE INDEX "knowledge_folders_base_parent_idx" ON "knowledge_folders" USING btree ("base_id","parent_id");--> statement-breakpoint
CREATE INDEX "knowledge_jobs_status_created_idx" ON "knowledge_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_jobs_base_created_idx" ON "knowledge_jobs" USING btree ("base_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "knowledge_jobs_document_idx" ON "knowledge_jobs" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_model_profiles_kind_name_idx" ON "knowledge_model_profiles" USING btree ("kind","name");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_source_ranges_scope_idx" ON "knowledge_source_ranges" USING btree ("source_id","kind","external_id",coalesce("ref", ''));--> statement-breakpoint
CREATE INDEX "knowledge_sources_base_idx" ON "knowledge_sources" USING btree ("base_id");--> statement-breakpoint
CREATE INDEX "knowledge_sync_runs_source_idx" ON "knowledge_sync_runs" USING btree ("source_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_tags_base_name_idx" ON "knowledge_tags" USING btree ("base_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_wiki_pages_base_slug_idx" ON "knowledge_wiki_pages" USING btree ("base_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_wiki_sources_page_chunk_idx" ON "knowledge_wiki_sources" USING btree ("page_id","chunk_id");--> statement-breakpoint
CREATE INDEX "knowledge_wiki_sources_document_idx" ON "knowledge_wiki_sources" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_wiki_versions_page_version_idx" ON "knowledge_wiki_versions" USING btree ("page_id","version");--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_kind_check" CHECK ("servers"."kind" in ('stdio', 'http', 'generated', 'knowledge'));--> statement-breakpoint
-- 手工补：drizzle 的 index() 不支持 hnsw + vector_cosine_ops。部分索引只覆盖可召回的行。
CREATE INDEX "knowledge_chunks_embedding_idx" ON "knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops) WHERE "knowledge_chunks"."enabled" and "knowledge_chunks"."embedding" is not null;