CREATE TABLE "data_domain_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"data_domain_id" text NOT NULL,
	"business_id" text NOT NULL,
	"properties" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_domain_identities_business_check" CHECK (length("data_domain_identities"."business_id") > 0)
);
--> statement-breakpoint
ALTER TABLE "data_domain_identities" ADD CONSTRAINT "data_domain_identities_data_domain_id_data_domains_id_fk" FOREIGN KEY ("data_domain_id") REFERENCES "public"."data_domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "data_domain_identities_domain_business_idx" ON "data_domain_identities" USING btree ("data_domain_id","business_id");--> statement-breakpoint
CREATE INDEX "data_domain_identities_domain_idx" ON "data_domain_identities" USING btree ("data_domain_id");