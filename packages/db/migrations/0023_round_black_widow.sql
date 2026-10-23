ALTER TABLE "agents" ALTER COLUMN "role" SET DEFAULT '通用助手';--> statement-breakpoint
UPDATE "agents" SET "role" = '通用助手' WHERE "role" ~ '^[[:space:]]*$';
