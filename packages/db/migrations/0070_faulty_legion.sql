ALTER TABLE "api_tools" ADD COLUMN "approval_mode" text DEFAULT 'allow' NOT NULL;--> statement-breakpoint
UPDATE "api_tools" SET "approval_mode" = CASE WHEN "requires_approval" THEN 'ask' ELSE 'allow' END;--> statement-breakpoint
ALTER TABLE "api_tools" DROP COLUMN "requires_approval";