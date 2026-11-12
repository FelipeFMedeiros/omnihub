import type {
  CanonicalOrder, CanonicalOrderStatus, MarketplaceSource, StockMovementReason,
} from '@omnihub/canonical-ir';
import { sql } from 'drizzle-orm';
import {
  check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar,
} from 'drizzle-orm/pg-core';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const primaryId = () => uuid('id').primaryKey().$defaultFn(() => Bun.randomUUIDv7());
const utc = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const products = pgTable('products', {
  id: primaryId(),
  sku: varchar('sku', { length: 100 }).notNull().unique(),
  title: text('title').notNull(),
  basePriceCents: integer('base_price_cents').notNull(),
  currentStock: integer('current_stock').notNull().default(0),
  reservedStock: integer('reserved_stock').notNull().default(0),
  safetyStock: integer('safety_stock').notNull().default(2),
  createdAt: utc('created_at').defaultNow().notNull(),
  updatedAt: utc('updated_at').defaultNow().notNull(),
}, (table) => [
  check('products_price_nonnegative', sql`${table.basePriceCents} >= 0`),
  check('products_stock_nonnegative', sql`${table.currentStock} >= 0 AND ${table.reservedStock} >= 0 AND ${table.safetyStock} >= 0`),
]);

export const spokeMappings = pgTable('spoke_mappings', {
  id: primaryId(),
  productId: uuid('product_id').references(() => products.id, { onDelete: 'cascade' }).notNull(),
  marketplace: varchar('marketplace', { length: 30 }).$type<Exclude<MarketplaceSource, 'MANUAL'>>().notNull(),
  externalItemId: varchar('external_item_id', { length: 150 }).notNull(),
  externalVariantId: varchar('external_variant_id', { length: 100 }).notNull().default(''),
  externalSku: varchar('external_sku', { length: 150 }),
  syncEnabled: varchar('sync_enabled', { length: 1 }).$type<'Y' | 'N'>().default('Y').notNull(),
  lastSyncedAt: utc('last_synced_at'),
  lastSyncError: varchar('last_sync_error', { length: 100 }),
  lastSyncQuantity: integer('last_sync_quantity'),
}, (table) => [
  uniqueIndex('marketplace_item_idx').on(table.marketplace, table.externalItemId, table.externalVariantId),
  index('spoke_mappings_product_idx').on(table.productId),
  check('spoke_mappings_marketplace_valid', sql`${table.marketplace} IN ('MERCADO_LIVRE', 'SHOPEE', 'AMAZON')`),
  check('spoke_mappings_sync_enabled_valid', sql`${table.syncEnabled} IN ('Y', 'N')`),
]);

export const canonicalOrders = pgTable('canonical_orders', {
  id: primaryId(),
  source: varchar('source', { length: 30 }).$type<MarketplaceSource>().notNull(),
  externalOrderId: varchar('external_order_id', { length: 100 }).notNull(),
  status: varchar('status', { length: 30 }).$type<CanonicalOrderStatus>().notNull(),
  totalAmountCents: integer('total_amount_cents').notNull(),
  customerPayload: jsonb('customer_payload').$type<CanonicalOrder['customer']>().notNull(),
  shippingPayload: jsonb('shipping_payload').$type<CanonicalOrder['shippingAddress']>().notNull(),
  itemsPayload: jsonb('items_payload').$type<CanonicalOrder['items']>().notNull(),
  rawPayload: jsonb('raw_payload').$type<JsonValue>().notNull(),
  createdAt: utc('created_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('source_order_idx').on(table.source, table.externalOrderId),
  check('canonical_orders_total_nonnegative', sql`${table.totalAmountCents} >= 0`),
  check('canonical_orders_source_valid', sql`${table.source} IN ('MERCADO_LIVRE', 'SHOPEE', 'AMAZON', 'MANUAL')`),
  check('canonical_orders_status_valid', sql`${table.status} IN ('PENDING', 'PAID', 'INVOICED', 'SHIPPED', 'DELIVERED', 'CANCELLED')`),
  check('canonical_orders_items_nonempty', sql`jsonb_typeof(${table.itemsPayload}) = 'array' AND jsonb_array_length(${table.itemsPayload}) > 0`),
]);

export const inventoryLedger = pgTable('inventory_ledger', {
  id: primaryId(),
  productId: uuid('product_id').references(() => products.id).notNull(),
  orderId: uuid('order_id').references(() => canonicalOrders.id),
  delta: integer('delta').notNull(),
  reason: varchar('reason', { length: 50 }).$type<StockMovementReason>().notNull(),
  availableAfter: integer('available_after').notNull(),
  timestamp: utc('timestamp').defaultNow().notNull(),
}, (table) => [
  index('inventory_ledger_product_timestamp_idx').on(table.productId, table.timestamp),
  index('inventory_ledger_order_idx').on(table.orderId),
  check('inventory_ledger_available_nonnegative', sql`${table.availableAfter} >= 0`),
  check('inventory_ledger_reason_valid', sql`${table.reason} IN ('SALE', 'CANCELLATION', 'ERP_SYNC', 'MANUAL_ADJUST', 'FULFILLMENT')`),
]);

/** Fila durável e snapshot por notificação. JSON integral é privado; consultas usam projeções. */
export const pipelineJobs = pgTable('pipeline_jobs', {
  id: primaryId(), source: varchar('source', { length: 30 }).$type<Exclude<MarketplaceSource, 'MANUAL'>>().notNull(),
  transportMode: varchar('transport_mode', { length: 30 }).$type<'OFFICIAL_TEST_USER' | 'LOCAL_FIXTURE'>().notNull().default('OFFICIAL_TEST_USER'),
  externalOrderId: varchar('external_order_id', { length: 100 }).notNull(),
  fingerprint: varchar('fingerprint', { length: 64 }).notNull().unique(),
  receiptCount: integer('receipt_count').notNull().default(1),
  orderId: uuid('order_id').references(() => canonicalOrders.id, { onDelete: 'set null' }),
  state: varchar('state', { length: 20 }).$type<'QUEUED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED'>().notNull().default('QUEUED'),
  outcome: varchar('outcome', { length: 30 }).$type<'CREATED' | 'DUPLICATE' | 'CANCELLED' | 'REJECTED' | 'FAILED'>(),
  errorCode: varchar('error_code', { length: 100 }), leaseUntil: utc('lease_until'), leaseToken: uuid('lease_token'),
  rawSnapshot: jsonb('raw_snapshot').$type<JsonValue>(), canonicalSnapshot: jsonb('canonical_snapshot').$type<JsonValue>(),
  erpSnapshot: jsonb('erp_snapshot').$type<JsonValue>(),
  timings: jsonb('timings').$type<Record<string, number>>(),
  createdAt: utc('created_at').defaultNow().notNull(), finishedAt: utc('finished_at'),
}, table => [index('pipeline_jobs_state_idx').on(table.state, table.createdAt)]);

export const erpDispatches = pgTable('erp_dispatches', {
  orderId: uuid('order_id').primaryKey().references(() => canonicalOrders.id, { onDelete: 'cascade' }),
  state: varchar('state', { length: 20 }).$type<'PENDING' | 'PROCESSING' | 'CONFIRMED' | 'EXHAUSTED' | 'FAILED'>().notNull().default('PENDING'),
  payload: jsonb('payload').$type<JsonValue>().notNull(),
  attempts: integer('attempts').notNull().default(0), protocol: varchar('protocol', { length: 250 }),
  leaseUntil: utc('lease_until'), errorCode: varchar('error_code', { length: 100 }),
  createdAt: utc('created_at').defaultNow().notNull(), confirmedAt: utc('confirmed_at'),
}, table => [check('erp_dispatch_attempts_budget', sql`${table.attempts} >= 0 AND ${table.attempts} <= 3`)]);

export const erpAttempts = pgTable('erp_attempts', {
  id: primaryId(), orderId: uuid('order_id').notNull().references(() => erpDispatches.orderId, { onDelete: 'cascade' }),
  ordinal: integer('ordinal').notNull(), httpStatus: integer('http_status'),
  outcome: varchar('outcome', { length: 30 }).notNull().default('STARTED'), durationMs: integer('duration_ms'),
  startedAt: utc('started_at').defaultNow().notNull(), finishedAt: utc('finished_at'),
}, table => [uniqueIndex('erp_attempt_ordinal_idx').on(table.orderId, table.ordinal), check('erp_attempt_ordinal_range', sql`${table.ordinal} BETWEEN 1 AND 3`)]);
