CREATE TABLE "channel_agent_bindings" (
	"channel_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"conversation_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"auto_wake_on_all" boolean DEFAULT false NOT NULL,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_agent_bindings_status_check" CHECK ("channel_agent_bindings"."status" in ('active', 'paused', 'disconnected'))
);
--> statement-breakpoint
CREATE TABLE "channel_members" (
	"channel_id" text NOT NULL,
	"business_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"last_read_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_members_pk" PRIMARY KEY("channel_id","business_id"),
	CONSTRAINT "channel_members_role_check" CHECK ("channel_members"."role" in ('owner', 'admin', 'member', 'viewer')),
	CONSTRAINT "channel_members_last_read_seq_check" CHECK ("channel_members"."last_read_seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "channel_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"seq" bigserial NOT NULL,
	"kind" text NOT NULL,
	"author_business_id" text,
	"agent_id" text,
	"run_id" text,
	"body" text NOT NULL,
	"client_message_id" text,
	"source_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_messages_kind_check" CHECK ("channel_messages"."kind" in ('human', 'agent', 'system'))
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_by" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_agent_bindings" ADD CONSTRAINT "channel_agent_bindings_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_agent_bindings" ADD CONSTRAINT "channel_agent_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_agent_bindings" ADD CONSTRAINT "channel_agent_bindings_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_agent_bindings_channel_agent_idx" ON "channel_agent_bindings" USING btree ("channel_id","agent_id");--> statement-breakpoint
CREATE INDEX "channel_agent_bindings_agent_idx" ON "channel_agent_bindings" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "channel_agent_bindings_conversation_idx" ON "channel_agent_bindings" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "channel_members_business_idx" ON "channel_members" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "channel_messages_channel_seq_idx" ON "channel_messages" USING btree ("channel_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_messages_client_message_idx" ON "channel_messages" USING btree ("channel_id","client_message_id") WHERE "channel_messages"."client_message_id" is not null;