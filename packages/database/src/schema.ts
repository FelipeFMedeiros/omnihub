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
  externalSku: varchar('external_sku', { length: 150 }),
  syncEnabled: varchar('sync_enabled', { length: 1 }).$type<'Y' | 'N'>().default('Y').notNull(),
  lastSyncedAt: utc('last_synced_at'),
}, (table) => [
  uniqueIndex('marketplace_item_idx').on(table.marketplace, table.externalItemId),
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
  check('inventory_ledger_reason_valid', sql`${table.reason} IN ('SALE', 'CANCELLATION', 'ERP_SYNC', 'MANUAL_ADJUST')`),
]);
