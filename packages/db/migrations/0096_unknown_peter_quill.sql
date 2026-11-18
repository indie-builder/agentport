ALTER TABLE "conversations" ADD COLUMN "provider_destination" text;--> statement-breakpoint
UPDATE "conversations" AS conversation
SET "provider_destination" = approved."destination"
FROM (
  SELECT DISTINCT ON (run."conversation_id") run."conversation_id", approval."destination"
  FROM "policy_approvals" AS approval
  INNER JOIN "agent_runs" AS run ON run."id" = approval."run_id"
  WHERE approval."status" = 'approved'
    AND approval."consumed_at" IS NOT NULL
    AND approval."destination" <> ''
  ORDER BY run."conversation_id", approval."consumed_at", approval."id"
) AS approved
WHERE conversation."id" = approved."conversation_id";