ALTER TABLE "plugins" ADD COLUMN "source_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "plugins_source_id_idx" ON "plugins" USING btree ("source_id");