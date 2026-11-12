CREATE TABLE "erp_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"http_status" integer,
	"outcome" varchar(30) DEFAULT 'STARTED' NOT NULL,
	"duration_ms" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "erp_attempt_ordinal_range" CHECK ("erp_attempts"."ordinal" BETWEEN 1 AND 3)
);
--> statement-breakpoint
CREATE TABLE "erp_dispatches" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"state" varchar(20) DEFAULT 'PENDING' NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"protocol" varchar(250),
	"lease_until" timestamp with time zone,
	"error_code" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "erp_dispatch_attempts_budget" CHECK ("erp_dispatches"."attempts" >= 0 AND "erp_dispatches"."attempts" <= 3)
);
--> statement-breakpoint
CREATE TABLE "pipeline_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source" varchar(30) NOT NULL,
	"external_order_id" varchar(100) NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"receipt_count" integer DEFAULT 1 NOT NULL,
	"order_id" uuid,
	"state" varchar(20) DEFAULT 'QUEUED' NOT NULL,
	"outcome" varchar(30),
	"error_code" varchar(100),
	"lease_until" timestamp with time zone,
	"lease_token" uuid,
	"raw_snapshot" jsonb,
	"canonical_snapshot" jsonb,
	"erp_snapshot" jsonb,
	"timings" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "pipeline_jobs_fingerprint_unique" UNIQUE("fingerprint")
);
--> statement-breakpoint
ALTER TABLE "inventory_ledger" DROP CONSTRAINT "inventory_ledger_reason_valid";--> statement-breakpoint
DROP INDEX "marketplace_item_idx";--> statement-breakpoint
ALTER TABLE "spoke_mappings" ADD COLUMN "external_variant_id" varchar(100) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "spoke_mappings" ADD COLUMN "last_sync_error" varchar(100);--> statement-breakpoint
ALTER TABLE "spoke_mappings" ADD COLUMN "last_sync_quantity" integer;--> statement-breakpoint
ALTER TABLE "erp_attempts" ADD CONSTRAINT "erp_attempts_order_id_erp_dispatches_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."erp_dispatches"("order_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_dispatches" ADD CONSTRAINT "erp_dispatches_order_id_canonical_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."canonical_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_jobs" ADD CONSTRAINT "pipeline_jobs_order_id_canonical_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."canonical_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "erp_attempt_ordinal_idx" ON "erp_attempts" USING btree ("order_id","ordinal");--> statement-breakpoint
CREATE INDEX "pipeline_jobs_state_idx" ON "pipeline_jobs" USING btree ("state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_item_idx" ON "spoke_mappings" USING btree ("marketplace","external_item_id","external_variant_id");--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_reason_valid" CHECK ("inventory_ledger"."reason" IN ('SALE', 'CANCELLATION', 'ERP_SYNC', 'MANUAL_ADJUST', 'FULFILLMENT'));