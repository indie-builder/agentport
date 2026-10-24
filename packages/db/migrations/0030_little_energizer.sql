ALTER TABLE "skills" ADD COLUMN "license" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "compatibility" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;