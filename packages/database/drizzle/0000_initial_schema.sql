CREATE TABLE "canonical_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source" varchar(30) NOT NULL,
	"external_order_id" varchar(100) NOT NULL,
	"status" varchar(30) NOT NULL,
	"total_amount_cents" integer NOT NULL,
	"customer_payload" jsonb NOT NULL,
	"shipping_payload" jsonb NOT NULL,
	"items_payload" jsonb NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "canonical_orders_total_nonnegative" CHECK ("canonical_orders"."total_amount_cents" >= 0),
	CONSTRAINT "canonical_orders_source_valid" CHECK ("canonical_orders"."source" IN ('MERCADO_LIVRE', 'SHOPEE', 'AMAZON', 'MANUAL')),
	CONSTRAINT "canonical_orders_status_valid" CHECK ("canonical_orders"."status" IN ('PENDING', 'PAID', 'INVOICED', 'SHIPPED', 'DELIVERED', 'CANCELLED')),
	CONSTRAINT "canonical_orders_items_nonempty" CHECK (jsonb_typeof("canonical_orders"."items_payload") = 'array' AND jsonb_array_length("canonical_orders"."items_payload") > 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"order_id" uuid,
	"delta" integer NOT NULL,
	"reason" varchar(50) NOT NULL,
	"available_after" integer NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_ledger_available_nonnegative" CHECK ("inventory_ledger"."available_after" >= 0),
	CONSTRAINT "inventory_ledger_reason_valid" CHECK ("inventory_ledger"."reason" IN ('SALE', 'CANCELLATION', 'ERP_SYNC', 'MANUAL_ADJUST'))
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sku" varchar(100) NOT NULL,
	"title" text NOT NULL,
	"base_price_cents" integer NOT NULL,
	"current_stock" integer DEFAULT 0 NOT NULL,
	"reserved_stock" integer DEFAULT 0 NOT NULL,
	"safety_stock" integer DEFAULT 2 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_sku_unique" UNIQUE("sku"),
	CONSTRAINT "products_price_nonnegative" CHECK ("products"."base_price_cents" >= 0),
	CONSTRAINT "products_stock_nonnegative" CHECK ("products"."current_stock" >= 0 AND "products"."reserved_stock" >= 0 AND "products"."safety_stock" >= 0)
);
--> statement-breakpoint
CREATE TABLE "spoke_mappings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"marketplace" varchar(30) NOT NULL,
	"external_item_id" varchar(150) NOT NULL,
	"external_sku" varchar(150),
	"sync_enabled" varchar(1) DEFAULT 'Y' NOT NULL,
	"last_synced_at" timestamp with time zone,
	CONSTRAINT "spoke_mappings_marketplace_valid" CHECK ("spoke_mappings"."marketplace" IN ('MERCADO_LIVRE', 'SHOPEE', 'AMAZON')),
	CONSTRAINT "spoke_mappings_sync_enabled_valid" CHECK ("spoke_mappings"."sync_enabled" IN ('Y', 'N'))
);
--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_order_id_canonical_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."canonical_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spoke_mappings" ADD CONSTRAINT "spoke_mappings_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_order_idx" ON "canonical_orders" USING btree ("source","external_order_id");--> statement-breakpoint
CREATE INDEX "inventory_ledger_product_timestamp_idx" ON "inventory_ledger" USING btree ("product_id","timestamp");--> statement-breakpoint
CREATE INDEX "inventory_ledger_order_idx" ON "inventory_ledger" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_item_idx" ON "spoke_mappings" USING btree ("marketplace","external_item_id");--> statement-breakpoint
CREATE INDEX "spoke_mappings_product_idx" ON "spoke_mappings" USING btree ("product_id");
