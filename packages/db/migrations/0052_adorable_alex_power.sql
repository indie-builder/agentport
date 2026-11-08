CREATE TABLE "knowledge_base_pins" (
	"business_id" text NOT NULL,
	"base_id" text NOT NULL,
	"pinned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_base_pins" ADD CONSTRAINT "knowledge_base_pins_base_id_knowledge_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_base_pins_pk" ON "knowledge_base_pins" USING btree ("business_id","base_id");--> statement-breakpoint
CREATE INDEX "knowledge_base_pins_business_idx" ON "knowledge_base_pins" USING btree ("business_id","pinned_at" DESC NULLS LAST);