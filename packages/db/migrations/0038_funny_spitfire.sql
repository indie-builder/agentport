ALTER TABLE "skills" ADD COLUMN "license" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "compatibility" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;