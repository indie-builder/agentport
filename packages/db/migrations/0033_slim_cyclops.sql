CREATE TABLE "agent_plugins" (
	"agent_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"allow_hooks" boolean DEFAULT false NOT NULL,
	"allow_mcp" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_files" (
	"id" text PRIMARY KEY NOT NULL,
	"plugin_id" text NOT NULL,
	"path" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"executable" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugins" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"runtime_name" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"version" text DEFAULT '' NOT NULL,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_plugins" ADD CONSTRAINT "agent_plugins_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_plugins" ADD CONSTRAINT "agent_plugins_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_files" ADD CONSTRAINT "plugin_files_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_plugins_pk" ON "agent_plugins" USING btree ("agent_id","plugin_id");--> statement-breakpoint
CREATE INDEX "agent_plugins_plugin_idx" ON "agent_plugins" USING btree ("plugin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_files_plugin_path_idx" ON "plugin_files" USING btree ("plugin_id","path");--> statement-breakpoint
CREATE INDEX "plugin_files_plugin_idx" ON "plugin_files" USING btree ("plugin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plugins_slug_idx" ON "plugins" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "plugins_runtime_name_idx" ON "plugins" USING btree ("runtime_name");