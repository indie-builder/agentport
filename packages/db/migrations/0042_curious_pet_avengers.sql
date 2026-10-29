ALTER TABLE "agents" DROP COLUMN "max_thinking_tokens";--> statement-breakpoint
UPDATE "agent_versions" SET "snapshot" = "snapshot" - 'maxThinkingTokens' WHERE "snapshot" ? 'maxThinkingTokens';
