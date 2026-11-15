ALTER TABLE "agents" ADD COLUMN "monthly_budget_usd" numeric(10, 4);--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "budget_alert_ratio" numeric(4, 3) DEFAULT '0.800' NOT NULL;