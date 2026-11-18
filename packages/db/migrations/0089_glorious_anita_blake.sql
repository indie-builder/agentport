CREATE TABLE "api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"scopes" text[] NOT NULL,
	"owner_business_id" text NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_tokens_scopes_check" CHECK (cardinality("api_tokens"."scopes") > 0 and "api_tokens"."scopes" <@ array['runs.create', 'runs.read']::text[])
);
--> statement-breakpoint
CREATE TABLE "external_request_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_request_keys_source_kind_check" CHECK ("external_request_keys"."source_kind" in ('api_token', 'webhook'))
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"endpoint_id" text NOT NULL,
	"event_type" text NOT NULL,
	"source_id" text NOT NULL,
	"payload" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "webhook_deliveries_event_type_check" CHECK ("webhook_deliveries"."event_type" in ('run.completed', 'run.failed', 'approval.requested', 'budget.alert')),
	CONSTRAINT "webhook_deliveries_status_check" CHECK ("webhook_deliveries"."status" in ('pending', 'delivering', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"direction" text NOT NULL,
	"agent_id" text,
	"url" text,
	"secret_encrypted" text NOT NULL,
	"events" text[] DEFAULT '{}' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"owner_business_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_endpoints_events_check" CHECK ("webhook_endpoints"."events" <@ array['run.completed', 'run.failed', 'approval.requested', 'budget.alert']::text[]),
	CONSTRAINT "webhook_endpoints_direction_check" CHECK (("webhook_endpoints"."direction" = 'inbound' and "webhook_endpoints"."agent_id" is not null and "webhook_endpoints"."url" is null) or ("webhook_endpoints"."direction" = 'outbound' and "webhook_endpoints"."agent_id" is null and "webhook_endpoints"."url" is not null and cardinality("webhook_endpoints"."events") > 0))
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_token_hash_idx" ON "api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "api_tokens_owner_idx" ON "api_tokens" USING btree ("owner_business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_request_keys_key_idx" ON "external_request_keys" USING btree ("source_kind","source_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_event_idx" ON "webhook_deliveries" USING btree ("endpoint_id","event_type","source_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_status_next_idx" ON "webhook_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_owner_idx" ON "webhook_endpoints" USING btree ("owner_business_id");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_direction_idx" ON "webhook_endpoints" USING btree ("direction");