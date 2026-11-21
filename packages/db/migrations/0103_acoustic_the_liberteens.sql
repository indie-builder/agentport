ALTER TABLE "data_domain_enrichment_proposals" DROP CONSTRAINT "data_domain_enrichment_proposals_status_check";--> statement-breakpoint
ALTER TABLE "data_domain_query_approvals" DROP CONSTRAINT "data_domain_query_approvals_status_check";--> statement-breakpoint
ALTER TABLE "data_domain_query_logs" DROP CONSTRAINT "data_domain_query_logs_status_check";--> statement-breakpoint
ALTER TABLE "data_domain_enrichment_proposals" ADD CONSTRAINT "data_domain_enrichment_proposals_status_check" CHECK ("data_domain_enrichment_proposals"."status" in ('generating', 'ready', 'approved', 'rejected', 'failed'));--> statement-breakpoint
ALTER TABLE "data_domain_query_approvals" ADD CONSTRAINT "data_domain_query_approvals_status_check" CHECK ("data_domain_query_approvals"."status" in ('pending', 'approved', 'rejected'));--> statement-breakpoint
ALTER TABLE "data_domain_query_logs" ADD CONSTRAINT "data_domain_query_logs_status_check" CHECK ("data_domain_query_logs"."status" in ('ok', 'error'));