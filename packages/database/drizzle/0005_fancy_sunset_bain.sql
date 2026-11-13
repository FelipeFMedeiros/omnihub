CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"platform" varchar(30) NOT NULL,
	"transport_mode" varchar(30) NOT NULL,
	"external_account_id" varchar(150),
	"state" varchar(20) DEFAULT 'DISABLED' NOT NULL,
	"name" varchar(120) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_platform" CHECK ("connections"."platform" IN ('MERCADO_LIVRE','SHOPEE','AMAZON')),
	CONSTRAINT "connections_transport" CHECK ("connections"."transport_mode" IN ('LOCAL_FIXTURE','OFFICIAL_TEST_USER')),
	CONSTRAINT "connections_state" CHECK ("connections"."state" IN ('ACTIVE','DISABLED') AND ("connections"."state" <> 'ACTIVE' OR "connections"."external_account_id" IS NOT NULL)),
	CONSTRAINT "connections_identity_nonempty" CHECK ("connections"."external_account_id" IS NULL OR length(btrim("connections"."external_account_id")) > 0)
);
--> statement-breakpoint
CREATE TABLE "erp_destinations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"config_key" varchar(120) NOT NULL,
	"state" varchar(20) DEFAULT 'DISABLED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "erp_destinations_config_key_unique" UNIQUE("config_key"),
	CONSTRAINT "erp_destinations_state" CHECK ("erp_destinations"."state" IN ('ACTIVE','DISABLED'))
);
--> statement-breakpoint
ALTER TABLE "pipeline_jobs" DROP CONSTRAINT "pipeline_jobs_fingerprint_unique";
--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT "products_sku_unique";
--> statement-breakpoint
ALTER TABLE "erp_attempts" DROP CONSTRAINT "erp_attempts_order_id_erp_dispatches_order_id_fk";
--> statement-breakpoint
ALTER TABLE "erp_dispatches" DROP CONSTRAINT "erp_dispatches_order_id_canonical_orders_id_fk";
--> statement-breakpoint
ALTER TABLE "inventory_ledger" DROP CONSTRAINT "inventory_ledger_product_id_products_id_fk";
--> statement-breakpoint
ALTER TABLE "inventory_ledger" DROP CONSTRAINT "inventory_ledger_order_id_canonical_orders_id_fk";
--> statement-breakpoint
ALTER TABLE "pipeline_jobs" DROP CONSTRAINT "pipeline_jobs_order_id_canonical_orders_id_fk";
--> statement-breakpoint
ALTER TABLE "spoke_mappings" DROP CONSTRAINT "spoke_mappings_product_id_products_id_fk";
--> statement-breakpoint
ALTER TABLE "workspaces" DROP CONSTRAINT "workspaces_owner_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "source_order_idx";
--> statement-breakpoint
DROP INDEX "pipeline_jobs_state_idx";
--> statement-breakpoint
DROP INDEX "marketplace_item_idx";
--> statement-breakpoint
ALTER TABLE "workspaces" ALTER COLUMN "owner_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "canonical_orders" ADD COLUMN "workspace_id" uuid;
--> statement-breakpoint
ALTER TABLE "canonical_orders" ADD COLUMN "connection_id" uuid;
--> statement-breakpoint
ALTER TABLE "erp_attempts" ADD COLUMN "workspace_id" uuid;
--> statement-breakpoint
ALTER TABLE "erp_attempts" ADD COLUMN "erp_destination_id" uuid;
--> statement-breakpoint
ALTER TABLE "erp_dispatches" ADD COLUMN "workspace_id" uuid;
--> statement-breakpoint
ALTER TABLE "erp_dispatches" ADD COLUMN "erp_destination_id" uuid;
--> statement-breakpoint
ALTER TABLE "erp_dispatches" ADD COLUMN "external_idempotency_key" varchar(300);
--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD COLUMN "workspace_id" uuid;
--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD COLUMN "erp_destination_id" uuid;
--> statement-breakpoint
ALTER TABLE "pipeline_jobs" ADD COLUMN "workspace_id" uuid;
--> statement-breakpoint
ALTER TABLE "pipeline_jobs" ADD COLUMN "connection_id" uuid;
--> statement-breakpoint
ALTER TABLE "pipeline_jobs" ADD COLUMN "erp_destination_id" uuid;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "workspace_id" uuid;
--> statement-breakpoint
ALTER TABLE "spoke_mappings" ADD COLUMN "workspace_id" uuid;
--> statement-breakpoint
ALTER TABLE "spoke_mappings" ADD COLUMN "connection_id" uuid;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "kind" varchar(20) DEFAULT 'ACCOUNT' NOT NULL;
--> statement-breakpoint
INSERT INTO workspaces(id,owner_id,name,kind) VALUES ('018f0000-0000-7000-8000-000000000013',NULL,'Legado fechado','LEGACY_CLOSED');
--> statement-breakpoint
INSERT INTO erp_destinations(id,workspace_id,config_key,state) VALUES ('018f0000-0000-7000-8000-000000000130','018f0000-0000-7000-8000-000000000013','legacy-closed','DISABLED');
--> statement-breakpoint
INSERT INTO connections(id,workspace_id,platform,transport_mode,name,state) VALUES ('018f0000-0000-7000-8000-000000000131','018f0000-0000-7000-8000-000000000013','MERCADO_LIVRE','OFFICIAL_TEST_USER','Legado fechado MERCADO_LIVRE','DISABLED');
--> statement-breakpoint
UPDATE canonical_orders SET connection_id='018f0000-0000-7000-8000-000000000131' WHERE source='MERCADO_LIVRE';
--> statement-breakpoint
UPDATE pipeline_jobs SET connection_id='018f0000-0000-7000-8000-000000000131' WHERE source='MERCADO_LIVRE';
--> statement-breakpoint
UPDATE spoke_mappings SET connection_id='018f0000-0000-7000-8000-000000000131' WHERE marketplace='MERCADO_LIVRE';
--> statement-breakpoint
INSERT INTO connections(id,workspace_id,platform,transport_mode,name,state) VALUES ('018f0000-0000-7000-8000-000000000132','018f0000-0000-7000-8000-000000000013','SHOPEE','OFFICIAL_TEST_USER','Legado fechado SHOPEE','DISABLED');
--> statement-breakpoint
UPDATE canonical_orders SET connection_id='018f0000-0000-7000-8000-000000000132' WHERE source='SHOPEE';
--> statement-breakpoint
UPDATE pipeline_jobs SET connection_id='018f0000-0000-7000-8000-000000000132' WHERE source='SHOPEE';
--> statement-breakpoint
UPDATE spoke_mappings SET connection_id='018f0000-0000-7000-8000-000000000132' WHERE marketplace='SHOPEE';
--> statement-breakpoint
INSERT INTO connections(id,workspace_id,platform,transport_mode,name,state) VALUES ('018f0000-0000-7000-8000-000000000133','018f0000-0000-7000-8000-000000000013','AMAZON','OFFICIAL_TEST_USER','Legado fechado AMAZON','DISABLED');
--> statement-breakpoint
UPDATE canonical_orders SET connection_id='018f0000-0000-7000-8000-000000000133' WHERE source='AMAZON';
--> statement-breakpoint
UPDATE pipeline_jobs SET connection_id='018f0000-0000-7000-8000-000000000133' WHERE source='AMAZON';
--> statement-breakpoint
UPDATE spoke_mappings SET connection_id='018f0000-0000-7000-8000-000000000133' WHERE marketplace='AMAZON';
--> statement-breakpoint
UPDATE products SET workspace_id='018f0000-0000-7000-8000-000000000013';
--> statement-breakpoint
UPDATE spoke_mappings SET workspace_id='018f0000-0000-7000-8000-000000000013';
--> statement-breakpoint
UPDATE canonical_orders SET workspace_id='018f0000-0000-7000-8000-000000000013';
--> statement-breakpoint
UPDATE inventory_ledger SET workspace_id='018f0000-0000-7000-8000-000000000013';
--> statement-breakpoint
UPDATE pipeline_jobs SET workspace_id='018f0000-0000-7000-8000-000000000013';
--> statement-breakpoint
UPDATE erp_dispatches SET workspace_id='018f0000-0000-7000-8000-000000000013';
--> statement-breakpoint
UPDATE erp_attempts SET workspace_id='018f0000-0000-7000-8000-000000000013';
--> statement-breakpoint
UPDATE erp_dispatches SET erp_destination_id='018f0000-0000-7000-8000-000000000130';
--> statement-breakpoint
UPDATE erp_attempts SET erp_destination_id='018f0000-0000-7000-8000-000000000130';
--> statement-breakpoint
UPDATE pipeline_jobs SET erp_destination_id='018f0000-0000-7000-8000-000000000130';
--> statement-breakpoint
UPDATE erp_dispatches SET external_idempotency_key=payload->>'codigo_pedido';
--> statement-breakpoint
ALTER TABLE "canonical_orders" ALTER COLUMN "workspace_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "erp_attempts" ALTER COLUMN "workspace_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "erp_attempts" ALTER COLUMN "erp_destination_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "erp_dispatches" ALTER COLUMN "workspace_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "erp_dispatches" ALTER COLUMN "erp_destination_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "erp_dispatches" ALTER COLUMN "external_idempotency_key" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "inventory_ledger" ALTER COLUMN "workspace_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "pipeline_jobs" ALTER COLUMN "workspace_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "pipeline_jobs" ALTER COLUMN "connection_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "pipeline_jobs" ALTER COLUMN "erp_destination_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "workspace_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "spoke_mappings" ALTER COLUMN "workspace_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "spoke_mappings" ALTER COLUMN "connection_id" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "connections_scope_id" ON "connections" USING btree ("workspace_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "connections_scope_channel" ON "connections" USING btree ("workspace_id","id","platform");
--> statement-breakpoint
CREATE UNIQUE INDEX "connections_scope_transport" ON "connections" USING btree ("workspace_id","id","platform","transport_mode");
--> statement-breakpoint
CREATE UNIQUE INDEX "connections_external_identity" ON "connections" USING btree ("platform","external_account_id") WHERE "connections"."external_account_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "erp_destinations_scope_id" ON "erp_destinations" USING btree ("workspace_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "erp_destinations_one_active" ON "erp_destinations" USING btree ("workspace_id") WHERE "erp_destinations"."state" = 'ACTIVE';
--> statement-breakpoint
CREATE UNIQUE INDEX "orders_scope_id" ON "canonical_orders" USING btree ("workspace_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "orders_scope_connection_id" ON "canonical_orders" USING btree ("workspace_id","connection_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "manual_order_idx" ON "canonical_orders" USING btree ("workspace_id","external_order_id") WHERE "canonical_orders"."source" = 'MANUAL' AND "canonical_orders"."connection_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_scope_id" ON "erp_dispatches" USING btree ("workspace_id","erp_destination_id","order_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_external_key" ON "erp_dispatches" USING btree ("erp_destination_id","external_idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_fingerprint_scope" ON "pipeline_jobs" USING btree ("workspace_id","connection_id","transport_mode","fingerprint");
--> statement-breakpoint
CREATE UNIQUE INDEX "products_scope_id" ON "products" USING btree ("workspace_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "products_workspace_sku" ON "products" USING btree ("workspace_id","sku");
--> statement-breakpoint
CREATE UNIQUE INDEX "source_order_idx" ON "canonical_orders" USING btree ("workspace_id","connection_id","external_order_id") WHERE "canonical_orders"."connection_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "pipeline_jobs_state_idx" ON "pipeline_jobs" USING btree ("workspace_id","connection_id","source","transport_mode","state","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_item_idx" ON "spoke_mappings" USING btree ("workspace_id","connection_id","external_item_id","external_variant_id");
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "erp_destinations" ADD CONSTRAINT "erp_destinations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "canonical_orders" ADD CONSTRAINT "canonical_orders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "canonical_orders" ADD CONSTRAINT "order_connection_scope" FOREIGN KEY ("workspace_id","connection_id","source") REFERENCES "public"."connections"("workspace_id","id","platform") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "erp_attempts" ADD CONSTRAINT "erp_attempts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "erp_attempts" ADD CONSTRAINT "attempt_dispatch_scope" FOREIGN KEY ("workspace_id","erp_destination_id","order_id") REFERENCES "public"."erp_dispatches"("workspace_id","erp_destination_id","order_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "erp_dispatches" ADD CONSTRAINT "erp_dispatches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "erp_dispatches" ADD CONSTRAINT "dispatch_order_scope" FOREIGN KEY ("workspace_id","order_id") REFERENCES "public"."canonical_orders"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "erp_dispatches" ADD CONSTRAINT "dispatch_erp_scope" FOREIGN KEY ("workspace_id","erp_destination_id") REFERENCES "public"."erp_destinations"("workspace_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "ledger_product_scope" FOREIGN KEY ("workspace_id","product_id") REFERENCES "public"."products"("workspace_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "ledger_order_scope" FOREIGN KEY ("workspace_id","order_id") REFERENCES "public"."canonical_orders"("workspace_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "ledger_erp_scope" FOREIGN KEY ("workspace_id","erp_destination_id") REFERENCES "public"."erp_destinations"("workspace_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pipeline_jobs" ADD CONSTRAINT "pipeline_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pipeline_jobs" ADD CONSTRAINT "job_connection_scope" FOREIGN KEY ("workspace_id","connection_id","source") REFERENCES "public"."connections"("workspace_id","id","platform") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pipeline_jobs" ADD CONSTRAINT "job_order_scope" FOREIGN KEY ("workspace_id","connection_id","order_id") REFERENCES "public"."canonical_orders"("workspace_id","connection_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pipeline_jobs" ADD CONSTRAINT "job_erp_scope" FOREIGN KEY ("workspace_id","erp_destination_id") REFERENCES "public"."erp_destinations"("workspace_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "spoke_mappings" ADD CONSTRAINT "spoke_mappings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "spoke_mappings" ADD CONSTRAINT "mapping_product_scope" FOREIGN KEY ("workspace_id","product_id") REFERENCES "public"."products"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "spoke_mappings" ADD CONSTRAINT "mapping_connection_scope" FOREIGN KEY ("workspace_id","connection_id","marketplace") REFERENCES "public"."connections"("workspace_id","id","platform") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "canonical_orders" ADD CONSTRAINT "order_connection_origin" CHECK (("canonical_orders"."source" = 'MANUAL' AND "canonical_orders"."connection_id" IS NULL) OR ("canonical_orders"."source" <> 'MANUAL' AND "canonical_orders"."connection_id" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "erp_dispatches" ADD CONSTRAINT "dispatch_payload_key" CHECK (jsonb_typeof("erp_dispatches"."payload"->'codigo_pedido') = 'string' AND "erp_dispatches"."payload"->>'codigo_pedido' = "erp_dispatches"."external_idempotency_key");
--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_kind" CHECK (("workspaces"."kind" = 'ACCOUNT' AND "workspaces"."owner_id" IS NOT NULL) OR ("workspaces"."kind" = 'LEGACY_CLOSED' AND "workspaces"."owner_id" IS NULL));
--> statement-breakpoint
CREATE FUNCTION protect_sent_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.attempts > 0 AND (NEW.workspace_id,NEW.erp_destination_id,NEW.external_idempotency_key,NEW.payload,NEW.order_id) IS DISTINCT FROM (OLD.workspace_id,OLD.erp_destination_id,OLD.external_idempotency_key,OLD.payload,OLD.order_id) THEN
 RAISE EXCEPTION 'sent dispatch identity is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.attempts < OLD.attempts THEN RAISE EXCEPTION 'dispatch attempt budget cannot reset' USING ERRCODE='23514'; END IF;
 RETURN NEW; END $$;
--> statement-breakpoint
CREATE TRIGGER dispatch_identity_immutable BEFORE UPDATE ON erp_dispatches FOR EACH ROW EXECUTE FUNCTION protect_sent_dispatch();
