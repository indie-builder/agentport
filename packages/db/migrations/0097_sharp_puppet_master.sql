ALTER TABLE "provider_request_logs" DROP CONSTRAINT "provider_request_logs_provider_id_model_providers_id_fk";
--> statement-breakpoint
ALTER TABLE "provider_request_logs" ADD CONSTRAINT "provider_request_logs_provider_id_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE restrict ON UPDATE no action;