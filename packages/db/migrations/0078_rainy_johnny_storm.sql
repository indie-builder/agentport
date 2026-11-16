CREATE TABLE "data_domain_query_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"data_domain_id" text NOT NULL,
	"version_id" text,
	"server_id" text NOT NULL,
	"run_id" text NOT NULL,
	"actor_business_id" text,
	"sql_summary" text DEFAULT '' NOT NULL,
	"row_count" integer,
	"status" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_domain_query_logs_status_check" CHECK ("data_domain_query_logs"."status" in ('ok','error'))
);
--> statement-breakpoint
ALTER TABLE "data_domain_query_logs" ADD CONSTRAINT "data_domain_query_logs_data_domain_id_data_domains_id_fk" FOREIGN KEY ("data_domain_id") REFERENCES "public"."data_domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_domain_query_logs_domain_created_idx" ON "data_domain_query_logs" USING btree ("data_domain_id","created_at","id");--> statement-breakpoint
CREATE INDEX "data_domain_query_logs_run_idx" ON "data_domain_query_logs" USING btree ("run_id");