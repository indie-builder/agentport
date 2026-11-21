CREATE TABLE "tool_approval_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text,
	"server_id" text,
	"tool_id" text,
	"role" text,
	"http_method" text,
	"path_template" text,
	"approval_mode" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_approval_policies_approval_mode_check" CHECK ("tool_approval_policies"."approval_mode" in ('allow', 'ask', 'deny')),
	CONSTRAINT "tool_approval_policies_role_check" CHECK ("tool_approval_policies"."role" is null or "tool_approval_policies"."role" ~ '^(platform:[A-Za-z0-9_]+|agent:(owner|maintainer|user)|channel:(owner|admin|member|viewer)|service:(system|mcp))$')
);
--> statement-breakpoint
ALTER TABLE "tool_approval_policies" ADD CONSTRAINT "tool_approval_policies_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_approval_policies" ADD CONSTRAINT "tool_approval_policies_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_approval_policies" ADD CONSTRAINT "tool_approval_policies_tool_id_api_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."api_tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_approval_policies_lookup_idx" ON "tool_approval_policies" USING btree ("enabled","server_id","agent_id");