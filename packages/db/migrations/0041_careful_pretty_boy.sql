CREATE TABLE "runtime_environment_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"dockerfile" text NOT NULL,
	"base_image_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"image_tag" text,
	"image_id" text,
	"build_log" text DEFAULT '' NOT NULL,
	"log_truncated" boolean DEFAULT false NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_environment_versions_id_environment_idx" UNIQUE("id","environment_id"),
	CONSTRAINT "runtime_environment_versions_status_check" CHECK ("runtime_environment_versions"."status" in ('queued', 'building', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "runtime_environments" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"dockerfile" text DEFAULT '# syntax=docker/dockerfile:1
ARG RUNTIME_BASE_IMAGE=agentport/sandbox:dev
FROM ${RUNTIME_BASE_IMAGE}

USER root
# 在下面安装额外系统包；安装归档与缓存要及时清理。
# RUN apk add --no-cache <package> && rm -rf /var/cache/apk/*

USER node
WORKDIR /app
' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"online_version_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "runtime_environment_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "runtime_environment_name" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "runtime_environment_version_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "runtime_environment_image_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "runtime_environment_id" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "last_test_runtime_environment" jsonb;--> statement-breakpoint
ALTER TABLE "runtime_environment_versions" ADD CONSTRAINT "runtime_environment_versions_environment_id_runtime_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."runtime_environments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_environments" ADD CONSTRAINT "runtime_environments_online_version_fk" FOREIGN KEY ("online_version_id","id") REFERENCES "public"."runtime_environment_versions"("id","environment_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runtime_environment_versions_environment_created_idx" ON "runtime_environment_versions" USING btree ("environment_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_environments_name_idx" ON "runtime_environments" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_environments_default_idx" ON "runtime_environments" USING btree ("is_default") WHERE "runtime_environments"."is_default" = true;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_runtime_environment_id_runtime_environments_id_fk" FOREIGN KEY ("runtime_environment_id") REFERENCES "public"."runtime_environments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_runtime_environment_idx" ON "agents" USING btree ("runtime_environment_id") WHERE "agents"."runtime_environment_id" is not null;