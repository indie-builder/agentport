CREATE TABLE "agent_favorites" (
	"business_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_favorites_business_id_agent_id_pk" PRIMARY KEY("business_id","agent_id")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "visibility" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "status" text DEFAULT 'published' NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "reviewed_by" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "agent_favorites" ADD CONSTRAINT "agent_favorites_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_favorites_business_idx" ON "agent_favorites" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "agents_visibility_idx" ON "agents" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX "agents_archived_idx" ON "agents" USING btree ("archived_at") WHERE "agents"."archived_at" is not null;--> statement-breakpoint
CREATE INDEX "skills_status_updated_idx" ON "skills" USING btree ("status","updated_at");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_visibility_check" CHECK ("agents"."visibility" in ('private', 'organization'));--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_tags_check" CHECK (jsonb_typeof("agents"."tags") = 'array' and not jsonb_path_exists("agents"."tags", '$[*] ? (@.type() != "string")'));--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_status_check" CHECK ("skills"."status" in ('draft', 'pending', 'published', 'rejected'));