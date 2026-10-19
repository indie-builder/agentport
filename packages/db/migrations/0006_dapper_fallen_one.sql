ALTER TABLE "agents" ADD COLUMN "parent_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_parent_id_agents_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_parent_idx" ON "agents" USING btree ("parent_id");