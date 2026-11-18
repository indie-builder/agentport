CREATE TABLE "model_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"protocol" text DEFAULT 'anthropic' NOT NULL,
	"base_url" text NOT NULL,
	"credential_encrypted" text NOT NULL,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"monthly_budget_usd" numeric(14, 4),
	"alert_ratio" numeric(4, 3) DEFAULT '0.800' NOT NULL,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_providers_priority_check" CHECK ("model_providers"."priority" >= 0),
	CONSTRAINT "model_providers_alert_ratio_check" CHECK ("model_providers"."alert_ratio" >= 0 and "model_providers"."alert_ratio" <= 1),
	CONSTRAINT "model_providers_budget_check" CHECK ("model_providers"."monthly_budget_usd" is null or "model_providers"."monthly_budget_usd" >= 0),
	CONSTRAINT "model_providers_protocol_check" CHECK ("model_providers"."protocol" in ('anthropic', 'openai_compatible'))
);
--> statement-breakpoint
CREATE TABLE "provider_request_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text,
	"provider_id" text NOT NULL,
	"model" text,
	"status_code" integer,
	"error_kind" text,
	"duration_ms" integer NOT NULL,
	"upstream_request_id" text,
	"failover_from_provider_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_request_logs_error_kind_check" CHECK ("provider_request_logs"."error_kind" is null or "provider_request_logs"."error_kind" in ('network', 'timeout', 'rate_limit', 'auth', 'upstream', 'content_blocked'))
);
--> statement-breakpoint
CREATE TABLE "content_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"direction" text NOT NULL,
	"action" text NOT NULL,
	"match_type" text NOT NULL,
	"pattern" text NOT NULL,
	"case_sensitive" boolean DEFAULT false NOT NULL,
	"agent_id" text,
	"priority" integer DEFAULT 100 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_policies_priority_check" CHECK ("content_policies"."priority" >= 0),
	CONSTRAINT "content_policies_version_check" CHECK ("content_policies"."version" >= 1),
	CONSTRAINT "content_policies_direction_check" CHECK ("content_policies"."direction" in ('inbound', 'outbound')),
	CONSTRAINT "content_policies_action_check" CHECK ("content_policies"."action" in ('block', 'redact', 'require_approval')),
	CONSTRAINT "content_policies_match_type_check" CHECK ("content_policies"."match_type" in ('keyword', 'regex', 'secret', 'pii'))
);
--> statement-breakpoint
CREATE TABLE "policy_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_id" text,
	"policy_name" text NOT NULL,
	"policy_version" integer NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"run_id" text,
	"channel_id" text,
	"payload_hash" text NOT NULL,
	"destination" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"note" text,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "policy_approvals_status_check" CHECK ("policy_approvals"."status" in ('pending', 'approved', 'rejected', 'expired')),
	CONSTRAINT "policy_approvals_source_kind_check" CHECK ("policy_approvals"."source_kind" in ('run_prompt', 'channel_message', 'model_request', 'assistant_output'))
);
--> statement-breakpoint
CREATE TABLE "policy_events" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_id" text,
	"policy_name" text NOT NULL,
	"policy_version" integer NOT NULL,
	"direction" text NOT NULL,
	"action" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"run_id" text,
	"channel_id" text,
	"actor" text,
	"match_digest" text NOT NULL,
	"snippet" text NOT NULL,
	"destination" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_events_direction_check" CHECK ("policy_events"."direction" in ('inbound', 'outbound')),
	CONSTRAINT "policy_events_action_check" CHECK ("policy_events"."action" in ('block', 'redact', 'require_approval')),
	CONSTRAINT "policy_events_source_kind_check" CHECK ("policy_events"."source_kind" in ('run_prompt', 'channel_message', 'model_request', 'assistant_output'))
);
--> statement-breakpoint
CREATE TABLE "violation_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_id" text,
	"policy_name" text NOT NULL,
	"event_id" text,
	"run_id" text,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"assignee_business_id" text,
	"summary" text NOT NULL,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "violation_cases_subject_kind_check" CHECK ("violation_cases"."subject_kind" in ('user', 'agent', 'channel')),
	CONSTRAINT "violation_cases_severity_check" CHECK ("violation_cases"."severity" in ('low', 'medium', 'high')),
	CONSTRAINT "violation_cases_status_check" CHECK ("violation_cases"."status" in ('open', 'investigating', 'resolved', 'dismissed'))
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "provider_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "served_provider_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "provider_failovers" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "slo_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "slo_window_minutes" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "slo_run_success_target" numeric(4, 3) DEFAULT '0.950' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "slo_run_p95_latency_ms" integer DEFAULT 120000 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "slo_queue_oldest_wait_ms" integer DEFAULT 60000 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "slo_provider_error_rate_target" numeric(4, 3) DEFAULT '0.050' NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_request_logs" ADD CONSTRAINT "provider_request_logs_provider_id_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_approvals" ADD CONSTRAINT "policy_approvals_policy_id_content_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."content_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_events" ADD CONSTRAINT "policy_events_policy_id_content_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."content_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "violation_cases" ADD CONSTRAINT "violation_cases_policy_id_content_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."content_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_providers_name_idx" ON "model_providers" USING btree ("name");--> statement-breakpoint
CREATE INDEX "model_providers_enabled_priority_idx" ON "model_providers" USING btree ("enabled","priority");--> statement-breakpoint
CREATE INDEX "provider_request_logs_provider_created_idx" ON "provider_request_logs" USING btree ("provider_id","created_at");--> statement-breakpoint
CREATE INDEX "provider_request_logs_run_idx" ON "provider_request_logs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "provider_request_logs_created_idx" ON "provider_request_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "content_policies_direction_enabled_idx" ON "content_policies" USING btree ("direction","enabled","priority");--> statement-breakpoint
CREATE INDEX "policy_approvals_status_expires_idx" ON "policy_approvals" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "policy_approvals_requester_hash_idx" ON "policy_approvals" USING btree ("requested_by","payload_hash");--> statement-breakpoint
CREATE INDEX "policy_events_created_idx" ON "policy_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "policy_events_run_idx" ON "policy_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "policy_events_policy_created_idx" ON "policy_events" USING btree ("policy_id","created_at");--> statement-breakpoint
CREATE INDEX "violation_cases_status_created_idx" ON "violation_cases" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "violation_cases_assignee_idx" ON "violation_cases" USING btree ("assignee_business_id");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_provider_id_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_served_provider_id_model_providers_id_fk" FOREIGN KEY ("served_provider_id") REFERENCES "public"."model_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_provider_failovers_check" CHECK ("agent_runs"."provider_failovers" >= 0);--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_slo_window_check" CHECK ("platform_settings"."slo_window_minutes" >= 5 and "platform_settings"."slo_window_minutes" <= 1440);--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_slo_run_success_check" CHECK ("platform_settings"."slo_run_success_target" >= 0 and "platform_settings"."slo_run_success_target" <= 1);--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_slo_p95_check" CHECK ("platform_settings"."slo_run_p95_latency_ms" > 0);--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_slo_queue_wait_check" CHECK ("platform_settings"."slo_queue_oldest_wait_ms" > 0);--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_slo_provider_error_check" CHECK ("platform_settings"."slo_provider_error_rate_target" >= 0 and "platform_settings"."slo_provider_error_rate_target" <= 1);