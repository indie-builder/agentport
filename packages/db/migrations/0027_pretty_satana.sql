CREATE TABLE "skill_files" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_id" text NOT NULL,
	"path" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_files" ADD CONSTRAINT "skill_files_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_files_skill_path_idx" ON "skill_files" USING btree ("skill_id","path");--> statement-breakpoint
CREATE INDEX "skill_files_skill_idx" ON "skill_files" USING btree ("skill_id");