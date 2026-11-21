ALTER TABLE "agents" DROP CONSTRAINT "agents_permission_mode_check";--> statement-breakpoint
ALTER TABLE "data_domains" DROP CONSTRAINT "data_domains_query_approval_mode_check";--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_permission_mode_check" CHECK ("agents"."permission_mode" in ('default', 'acceptEdits', 'plan', 'dontAsk'));--> statement-breakpoint
ALTER TABLE "data_domains" ADD CONSTRAINT "data_domains_query_approval_mode_check" CHECK ("data_domains"."query_approval_mode" in ('off', 'all'));