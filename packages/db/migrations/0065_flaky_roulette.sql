ALTER TABLE "agents" DROP CONSTRAINT "agents_parent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_parent_id_agents_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;