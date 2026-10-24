ALTER TABLE "skills" ADD COLUMN "source_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "skills_source_id_idx" ON "skills" USING btree ("source_id");