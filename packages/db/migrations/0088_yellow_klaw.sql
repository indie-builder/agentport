CREATE TABLE "budget_limits" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text NOT NULL,
	"metric" text NOT NULL,
	"limit_value" numeric(14, 4) NOT NULL,
	"alert_ratio" numeric(4, 3) DEFAULT '0.800' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_limits_scope_metric_unique" UNIQUE("scope_kind","scope_id","metric"),
	CONSTRAINT "budget_limits_scope_kind_check" CHECK ("budget_limits"."scope_kind" in ('user', 'department', 'agent', 'knowledge_base', 'data_domain')),
	CONSTRAINT "budget_limits_metric_check" CHECK ("budget_limits"."metric" in ('cost_usd_month', 'documents', 'queries_month')),
	CONSTRAINT "budget_limits_scope_metric_check" CHECK (("budget_limits"."scope_kind" in ('user', 'department', 'agent') and "budget_limits"."metric" = 'cost_usd_month') or ("budget_limits"."scope_kind" = 'knowledge_base' and "budget_limits"."metric" = 'documents') or ("budget_limits"."scope_kind" = 'data_domain' and "budget_limits"."metric" = 'queries_month')),
	CONSTRAINT "budget_limits_value_check" CHECK ("budget_limits"."limit_value" >= 0),
	CONSTRAINT "budget_limits_alert_ratio_check" CHECK ("budget_limits"."alert_ratio" >= 0 and "budget_limits"."alert_ratio" <= 1)
);
--> statement-breakpoint
CREATE TABLE "department_members" (
	"department_id" text NOT NULL,
	"business_id" text NOT NULL,
	"is_manager" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "department_members_department_business_unique" UNIQUE("department_id","business_id")
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "departments_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "resource_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_id" text NOT NULL,
	"business_id" text NOT NULL,
	"can_use" boolean DEFAULT false NOT NULL,
	"can_manage" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_grants_resource_business_unique" UNIQUE("resource_kind","resource_id","business_id"),
	CONSTRAINT "resource_grants_kind_check" CHECK ("resource_grants"."resource_kind" in ('knowledge_base', 'data_domain', 'skill', 'server', 'plugin', 'runtime_environment')),
	CONSTRAINT "resource_grants_flags_check" CHECK ("resource_grants"."can_use" or "resource_grants"."can_manage")
);
--> statement-breakpoint
ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_scope_check";--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_check";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "department_id" text;--> statement-breakpoint
ALTER TABLE "data_domains" ADD COLUMN "owner_business_id" text;--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD COLUMN "owner_business_id" text;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "alert_run_failures_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "alert_run_failures_threshold" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "alert_run_failures_window_minutes" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "alert_queue_failed_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "alert_queue_failed_threshold" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "alert_queue_waiting_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "alert_queue_waiting_threshold" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN "owner_business_id" text;--> statement-breakpoint
ALTER TABLE "runtime_environments" ADD COLUMN "owner_business_id" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "owner_business_id" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "owner_business_id" text;--> statement-breakpoint
ALTER TABLE "department_members" ADD CONSTRAINT "department_members_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_limits_scope_idx" ON "budget_limits" USING btree ("scope_kind","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "department_members_business_idx" ON "department_members" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "resource_grants_business_kind_idx" ON "resource_grants" USING btree ("business_id","resource_kind");--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_scope_check" CHECK ("role_permissions"."scope" in ('own_data', 'authorized_resources', 'authorized_agents', 'maintained_agents', 'owned_agents', 'platform'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_check" CHECK ("notifications"."kind" in ('approval', 'question', 'run_failed', 'schedule_failed', 'budget_alert', 'ops_alert'));--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_run_failures_threshold_check" CHECK ("platform_settings"."alert_run_failures_threshold" > 0);--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_run_failures_window_check" CHECK ("platform_settings"."alert_run_failures_window_minutes" > 0);--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_queue_failed_threshold_check" CHECK ("platform_settings"."alert_queue_failed_threshold" > 0);--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_queue_waiting_threshold_check" CHECK ("platform_settings"."alert_queue_waiting_threshold" > 0);