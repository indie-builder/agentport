CREATE TABLE "agent_members" (
	"agent_id" text NOT NULL,
	"business_id" text NOT NULL,
	"can_use" boolean DEFAULT false NOT NULL,
	"can_maintain" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_members_flags_check" CHECK ("agent_members"."can_use" or "agent_members"."can_maintain")
);
--> statement-breakpoint
CREATE TABLE "platform_bootstrap" (
	"id" text PRIMARY KEY NOT NULL,
	"admin_business_id" text,
	"roles_revision" integer DEFAULT 0 NOT NULL,
	"initialized_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_bootstrap_revision_check" CHECK ("platform_bootstrap"."roles_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" text NOT NULL,
	"permission_id" text NOT NULL,
	"scope" text NOT NULL,
	CONSTRAINT "role_permissions_scope_check" CHECK ("role_permissions"."scope" in ('own_data', 'authorized_agents', 'maintained_agents', 'owned_agents', 'platform'))
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"system_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_system_key_check" CHECK ("roles"."system_key" is null or "roles"."system_key" in ('admin', 'user', 'owner', 'maintainer'))
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"business_id" text NOT NULL,
	"role_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_changes" RENAME COLUMN "user_id" TO "business_id";--> statement-breakpoint
ALTER TABLE "memory_reviews" RENAME COLUMN "user_id" TO "business_id";--> statement-breakpoint
ALTER TABLE "user_preferences" RENAME COLUMN "user_id" TO "business_id";--> statement-breakpoint
ALTER TABLE "memory_changes" DROP CONSTRAINT "memory_changes_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "memory_reviews" DROP CONSTRAINT "memory_reviews_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "user_preferences" DROP CONSTRAINT "user_preferences_user_id_user_id_fk";
--> statement-breakpoint
DROP INDEX "memory_changes_user_created_idx";--> statement-breakpoint
DROP INDEX "memory_reviews_user_request_idx";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "subject_kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "initiated_by" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "service_id" text;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN "created_by" text NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN "execute_as_business_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "created_by" text NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "owner_business_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_kind" text DEFAULT 'service' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "subject_business_id" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "business_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "disabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "service_id" text;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD COLUMN "created_by" text NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "created_by" text NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sender_business_id" text;--> statement-breakpoint
ALTER TABLE "agent_members" ADD CONSTRAINT "agent_members_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_members_pk" ON "agent_members" USING btree ("agent_id","business_id");--> statement-breakpoint
CREATE INDEX "agent_members_business_idx" ON "agent_members" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_permissions_pk" ON "role_permissions" USING btree ("role_id","permission_id","scope");--> statement-breakpoint
CREATE INDEX "role_permissions_permission_idx" ON "role_permissions" USING btree ("permission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_name_idx" ON "roles" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_system_key_idx" ON "roles" USING btree ("system_key");--> statement-breakpoint
CREATE UNIQUE INDEX "user_roles_pk" ON "user_roles" USING btree ("business_id","role_id");--> statement-breakpoint
CREATE INDEX "user_roles_role_idx" ON "user_roles" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "agent_runs_initiated_by_idx" ON "agent_runs" USING btree ("initiated_by");--> statement-breakpoint
CREATE INDEX "agents_owner_idx" ON "agents" USING btree ("owner_business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_business_id_idx" ON "user" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "conversations_created_by_idx" ON "conversations" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "memory_changes_business_created_idx" ON "memory_changes" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_reviews_business_request_idx" ON "memory_reviews" USING btree ("business_id","request_key");--> statement-breakpoint
CREATE INDEX "messages_sender_idx" ON "messages" USING btree ("sender_business_id");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_subject_kind_check" CHECK ("agent_runs"."subject_kind" in ('user', 'service'));--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_subject_check" CHECK (("agent_runs"."subject_kind" = 'user' and "agent_runs"."initiated_by" is not null and "agent_runs"."service_id" is null) or ("agent_runs"."subject_kind" = 'service' and "agent_runs"."initiated_by" is null and "agent_runs"."service_id" in ('system', 'mcp')));--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_subject_check" CHECK (("conversations"."created_by" is not null) <> ("conversations"."service_id" is not null));