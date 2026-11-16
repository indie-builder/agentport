CREATE TABLE "data_domain_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"data_domain_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"project_files" jsonb NOT NULL,
	"mdl_manifest" text,
	"log_tail" text DEFAULT '' NOT NULL,
	"log_truncated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_domain_versions_id_domain_idx" UNIQUE("id","data_domain_id"),
	CONSTRAINT "data_domain_versions_status_check" CHECK ("data_domain_versions"."status" in ('queued', 'building', 'ready', 'failed')),
	CONSTRAINT "data_domain_versions_ready_manifest_check" CHECK ("data_domain_versions"."status" <> 'ready' or "data_domain_versions"."mdl_manifest" is not null)
);
--> statement-breakpoint
CREATE TABLE "data_domains" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"datasource" text NOT NULL,
	"connection_encrypted" text NOT NULL,
	"online_version_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_domains_datasource_check" CHECK (length("data_domains"."datasource") > 0)
);
--> statement-breakpoint
ALTER TABLE "data_domain_versions" ADD CONSTRAINT "data_domain_versions_data_domain_id_data_domains_id_fk" FOREIGN KEY ("data_domain_id") REFERENCES "public"."data_domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_domains" ADD CONSTRAINT "data_domains_online_version_fk" FOREIGN KEY ("online_version_id","id") REFERENCES "public"."data_domain_versions"("id","data_domain_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_domain_versions_domain_created_idx" ON "data_domain_versions" USING btree ("data_domain_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "data_domains_slug_idx" ON "data_domains" USING btree ("slug");