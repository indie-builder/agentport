CREATE TABLE "data_domain_query_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"data_domain_id" text NOT NULL,
	"server_id" text NOT NULL,
	"run_id" text NOT NULL,
	"actor_business_id" text,
	"sql_text" text NOT NULL,
	"sql_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decision_note" text DEFAULT '' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_business_id" text,
	CONSTRAINT "data_domain_query_approvals_status_check" CHECK ("data_domain_query_approvals"."status" in ('pending','approved','rejected')),
	CONSTRAINT "data_domain_query_approvals_decision_check" CHECK (("data_domain_query_approvals"."status" = 'pending') = ("data_domain_query_approvals"."decided_at" is null))
);
--> statement-breakpoint
ALTER TABLE "data_domains" ADD COLUMN "query_approval_mode" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "data_domain_query_approvals" ADD CONSTRAINT "data_domain_query_approvals_data_domain_id_data_domains_id_fk" FOREIGN KEY ("data_domain_id") REFERENCES "public"."data_domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_domain_query_approvals_domain_created_idx" ON "data_domain_query_approvals" USING btree ("data_domain_id","requested_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "data_domain_query_approvals_pending_uniq" ON "data_domain_query_approvals" USING btree ("data_domain_id","run_id","sql_hash") WHERE "data_domain_query_approvals"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "data_domains" ADD CONSTRAINT "data_domains_query_approval_mode_check" CHECK ("data_domains"."query_approval_mode" in ('off','all'));