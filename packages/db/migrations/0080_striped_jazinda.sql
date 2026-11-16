CREATE TABLE "data_domain_enrichment_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"data_domain_id" text NOT NULL,
	"source_version_id" text NOT NULL,
	"status" text DEFAULT 'generating' NOT NULL,
	"instruction" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"project_files" jsonb,
	"error" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_business_id" text,
	CONSTRAINT "data_domain_enrichment_proposals_status_check" CHECK ("data_domain_enrichment_proposals"."status" in ('generating','ready','approved','rejected','failed'))
);
--> statement-breakpoint
ALTER TABLE "data_domain_enrichment_proposals" ADD CONSTRAINT "data_domain_enrichment_proposals_data_domain_id_data_domains_id_fk" FOREIGN KEY ("data_domain_id") REFERENCES "public"."data_domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_domain_enrichment_proposals_domain_created_idx" ON "data_domain_enrichment_proposals" USING btree ("data_domain_id","created_at","id");