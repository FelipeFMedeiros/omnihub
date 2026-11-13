import type {
  CanonicalOrder, CanonicalOrderStatus, MarketplaceSource, StockMovementReason,
} from '@omnihub/canonical-ir';
import { sql } from 'drizzle-orm';
import {
  check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar,
} from 'drizzle-orm/pg-core';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const primaryId = () => uuid('id').primaryKey().$defaultFn(() => Bun.randomUUIDv7());
const utc = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** Identidade da conta; não atribui propriedade às tabelas globais da PoC. */
export const users = pgTable('users', {
  id: primaryId(),
  name: varchar('name', { length: 120 }).notNull(),
  email: varchar('email', { length: 254 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: utc('created_at').defaultNow().notNull(),
}, table => [
  check('users_email_normalized', sql`${table.email} = lower(btrim(${table.email}))`),
  check('users_name_nonempty', sql`length(btrim(${table.name})) > 0`),
]);

export const workspaces = pgTable('workspaces', {
  id: primaryId(),
  ownerId: uuid('owner_id').unique().references(() => users.id, { onDelete: 'cascade' }),
  kind: varchar('kind', { length: 20 }).$type<'ACCOUNT' | 'LEGACY_CLOSED'>().notNull().default('ACCOUNT'),
  name: varchar('name', { length: 120 }).notNull().default('Meu negócio'),
  createdAt: utc('created_at').defaultNow().notNull(),
}, table => [check('workspaces_owner_kind', sql`(${table.kind} = 'ACCOUNT' AND ${table.ownerId} IS NOT NULL) OR (${table.kind} = 'LEGACY_CLOSED' AND ${table.ownerId} IS NULL)`)]);

export type TransportMode = 'OFFICIAL_TEST_USER' | 'LOCAL_FIXTURE';
export type Channel = Exclude<MarketplaceSource, 'MANUAL'>;
const workspaceId = () => uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'restrict' });
/** Identidade validada na borda; credenciais/OAuth por loja pertencem à TASK-014. */
export const connections = pgTable('connections', {
  id: primaryId(), workspaceId: workspaceId(),
  platform: varchar('platform', { length: 30 }).$type<Channel>().notNull(),
  transportMode: varchar('transport_mode', { length: 30 }).$type<TransportMode>().notNull(),
  externalAccountId: varchar('external_account_id', { length: 150 }),
  state: varchar('state', { length: 20 }).$type<'ACTIVE' | 'DISABLED'>().notNull().default('DISABLED'),
  name: varchar('name', { length: 120 }).notNull(), createdAt: utc('created_at').defaultNow().notNull(),
}, table => [
  uniqueIndex('connections_scope_id').on(table.workspaceId, table.id),
  uniqueIndex('connections_scope_channel').on(table.workspaceId, table.id, table.platform),
  uniqueIndex('connections_scope_transport').on(table.workspaceId, table.id, table.platform, table.transportMode),
  uniqueIndex('connections_external_identity').on(table.platform, table.externalAccountId).where(sql`${table.externalAccountId} IS NOT NULL`),
  check('connections_platform', sql`${table.platform} IN ('MERCADO_LIVRE','SHOPEE','AMAZON')`),
  check('connections_transport', sql`${table.transportMode} IN ('LOCAL_FIXTURE','OFFICIAL_TEST_USER')`),
  check('connections_state', sql`${table.state} IN ('ACTIVE','DISABLED') AND (${table.state} <> 'ACTIVE' OR ${table.externalAccountId} IS NOT NULL)`),
  check('connections_identity_nonempty', sql`${table.externalAccountId} IS NULL OR length(btrim(${table.externalAccountId})) > 0`),
]);

/** Chave de configuração permitida pelo operador; URLs/segredos não vêm do navegador. */
export const erpDestinations = pgTable('erp_destinations', {
  id: primaryId(), workspaceId: workspaceId(), configKey: varchar('config_key', { length: 120 }).notNull().unique(),
  endpointOrigin: varchar('endpoint_origin', { length: 200 }).unique(),
  state: varchar('state', { length: 20 }).$type<'ACTIVE' | 'DISABLED'>().notNull().default('DISABLED'),
  createdAt: utc('created_at').defaultNow().notNull(),
}, table => [
  uniqueIndex('erp_destinations_scope_id').on(table.workspaceId, table.id),
  uniqueIndex('erp_destinations_one_active').on(table.workspaceId).where(sql`${table.state} = 'ACTIVE'`),
  check('erp_destinations_state', sql`${table.state} IN ('ACTIVE','DISABLED')`),
  check('erp_destinations_endpoint', sql`(${table.state} <> 'ACTIVE' OR ${table.endpointOrigin} IS NOT NULL) AND (${table.endpointOrigin} IS NULL OR ${table.endpointOrigin} ~ '^http://127[.]0[.]0[.]1:[0-9]{1,5}$')`),
]);

export const authSessions = pgTable('auth_sessions', {
  id: primaryId(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  issuedAt: utc('issued_at').notNull(),
  expiresAt: utc('expires_at').notNull(),
  revokedAt: utc('revoked_at'),
}, table => [
  index('auth_sessions_user_idx').on(table.userId),
  index('auth_sessions_expiry_idx').on(table.expiresAt),
  check('auth_sessions_expiry_valid', sql`${table.expiresAt} > ${table.issuedAt}`),
]);

export const products = pgTable('products', {
  id: primaryId(),
  workspaceId: workspaceId(),
  sku: varchar('sku', { length: 100 }).notNull(),
  title: text('title').notNull(),
  basePriceCents: integer('base_price_cents').notNull(),
  currentStock: integer('current_stock').notNull().default(0),
  reservedStock: integer('reserved_stock').notNull().default(0),
  safetyStock: integer('safety_stock').notNull().default(2),
  createdAt: utc('created_at').defaultNow().notNull(),
  updatedAt: utc('updated_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('products_scope_id').on(table.workspaceId, table.id),
  uniqueIndex('products_workspace_sku').on(table.workspaceId, table.sku),
  check('products_price_nonnegative', sql`${table.basePriceCents} >= 0`),
  check('products_stock_nonnegative', sql`${table.currentStock} >= 0 AND ${table.reservedStock} >= 0 AND ${table.safetyStock} >= 0`),
]);

export const spokeMappings = pgTable('spoke_mappings', {
  id: primaryId(),
  workspaceId: workspaceId(), connectionId: uuid('connection_id').notNull(),
  productId: uuid('product_id').notNull(),
  marketplace: varchar('marketplace', { length: 30 }).$type<Exclude<MarketplaceSource, 'MANUAL'>>().notNull(),
  externalItemId: varchar('external_item_id', { length: 150 }).notNull(),
  externalVariantId: varchar('external_variant_id', { length: 100 }).notNull().default(''),
  externalSku: varchar('external_sku', { length: 150 }),
  syncEnabled: varchar('sync_enabled', { length: 1 }).$type<'Y' | 'N'>().default('Y').notNull(),
  lastSyncedAt: utc('last_synced_at'),
  lastSyncError: varchar('last_sync_error', { length: 100 }),
  lastSyncQuantity: integer('last_sync_quantity'),
}, (table) => [
  uniqueIndex('marketplace_item_idx').on(table.workspaceId, table.connectionId, table.externalItemId, table.externalVariantId),
  foreignKey({ columns: [table.workspaceId, table.productId], foreignColumns: [products.workspaceId, products.id], name: 'mapping_product_scope' }).onDelete('cascade'),
  foreignKey({ columns: [table.workspaceId, table.connectionId, table.marketplace], foreignColumns: [connections.workspaceId, connections.id, connections.platform], name: 'mapping_connection_scope' }),
  index('spoke_mappings_product_idx').on(table.productId),
  check('spoke_mappings_marketplace_valid', sql`${table.marketplace} IN ('MERCADO_LIVRE', 'SHOPEE', 'AMAZON')`),
  check('spoke_mappings_sync_enabled_valid', sql`${table.syncEnabled} IN ('Y', 'N')`),
]);

export const canonicalOrders = pgTable('canonical_orders', {
  id: primaryId(),
  workspaceId: workspaceId(), connectionId: uuid('connection_id'),
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
  uniqueIndex('orders_scope_id').on(table.workspaceId, table.id),
  uniqueIndex('orders_scope_connection_id').on(table.workspaceId, table.connectionId, table.id),
  uniqueIndex('source_order_idx').on(table.workspaceId, table.connectionId, table.externalOrderId).where(sql`${table.connectionId} IS NOT NULL`),
  uniqueIndex('manual_order_idx').on(table.workspaceId, table.externalOrderId).where(sql`${table.source} = 'MANUAL' AND ${table.connectionId} IS NULL`),
  check('order_connection_origin', sql`(${table.source} = 'MANUAL' AND ${table.connectionId} IS NULL) OR (${table.source} <> 'MANUAL' AND ${table.connectionId} IS NOT NULL)`),
  foreignKey({ columns: [table.workspaceId, table.connectionId, table.source], foreignColumns: [connections.workspaceId, connections.id, connections.platform], name: 'order_connection_scope' }),
  check('canonical_orders_total_nonnegative', sql`${table.totalAmountCents} >= 0`),
  check('canonical_orders_source_valid', sql`${table.source} IN ('MERCADO_LIVRE', 'SHOPEE', 'AMAZON', 'MANUAL')`),
  check('canonical_orders_status_valid', sql`${table.status} IN ('PENDING', 'PAID', 'INVOICED', 'SHIPPED', 'DELIVERED', 'CANCELLED')`),
  check('canonical_orders_items_nonempty', sql`jsonb_typeof(${table.itemsPayload}) = 'array' AND jsonb_array_length(${table.itemsPayload}) > 0`),
]);

export const inventoryLedger = pgTable('inventory_ledger', {
  id: primaryId(),
  workspaceId: workspaceId(), erpDestinationId: uuid('erp_destination_id'),
  productId: uuid('product_id').notNull(),
  orderId: uuid('order_id'),
  delta: integer('delta').notNull(),
  reason: varchar('reason', { length: 50 }).$type<StockMovementReason>().notNull(),
  availableAfter: integer('available_after').notNull(),
  timestamp: utc('timestamp').defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.workspaceId, table.productId], foreignColumns: [products.workspaceId, products.id], name: 'ledger_product_scope' }),
  foreignKey({ columns: [table.workspaceId, table.orderId], foreignColumns: [canonicalOrders.workspaceId, canonicalOrders.id], name: 'ledger_order_scope' }),
  foreignKey({ columns: [table.workspaceId, table.erpDestinationId], foreignColumns: [erpDestinations.workspaceId, erpDestinations.id], name: 'ledger_erp_scope' }),
  index('inventory_ledger_product_timestamp_idx').on(table.productId, table.timestamp),
  index('inventory_ledger_order_idx').on(table.orderId),
  check('inventory_ledger_available_nonnegative', sql`${table.availableAfter} >= 0`),
  check('inventory_ledger_reason_valid', sql`${table.reason} IN ('SALE', 'CANCELLATION', 'ERP_SYNC', 'MANUAL_ADJUST', 'FULFILLMENT')`),
]);

/** Fila durável e snapshot por notificação. JSON integral é privado; consultas usam projeções. */
export const pipelineJobs = pgTable('pipeline_jobs', {
  workspaceId: workspaceId(), connectionId: uuid('connection_id').notNull(), erpDestinationId: uuid('erp_destination_id').notNull(),
  id: primaryId(), source: varchar('source', { length: 30 }).$type<Exclude<MarketplaceSource, 'MANUAL'>>().notNull(),
  transportMode: varchar('transport_mode', { length: 30 }).$type<'OFFICIAL_TEST_USER' | 'LOCAL_FIXTURE'>().notNull().default('OFFICIAL_TEST_USER'),
  externalOrderId: varchar('external_order_id', { length: 100 }).notNull(),
  fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
  receiptCount: integer('receipt_count').notNull().default(1),
  orderId: uuid('order_id'),
  state: varchar('state', { length: 20 }).$type<'QUEUED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED'>().notNull().default('QUEUED'),
  outcome: varchar('outcome', { length: 30 }).$type<'CREATED' | 'DUPLICATE' | 'CANCELLED' | 'REJECTED' | 'FAILED'>(),
  errorCode: varchar('error_code', { length: 100 }), leaseUntil: utc('lease_until'), leaseToken: uuid('lease_token'),
  rawSnapshot: jsonb('raw_snapshot').$type<JsonValue>(), canonicalSnapshot: jsonb('canonical_snapshot').$type<JsonValue>(),
  erpSnapshot: jsonb('erp_snapshot').$type<JsonValue>(),
  timings: jsonb('timings').$type<Record<string, number>>(),
  createdAt: utc('created_at').defaultNow().notNull(), finishedAt: utc('finished_at'),
}, table => [
  index('pipeline_jobs_state_idx').on(table.workspaceId, table.connectionId, table.source, table.transportMode, table.state, table.createdAt),
  uniqueIndex('jobs_fingerprint_scope').on(table.workspaceId, table.connectionId, table.transportMode, table.fingerprint),
  foreignKey({ columns: [table.workspaceId, table.connectionId, table.source], foreignColumns: [connections.workspaceId, connections.id, connections.platform], name: 'job_connection_scope' }),
  foreignKey({ columns: [table.workspaceId, table.connectionId, table.orderId], foreignColumns: [canonicalOrders.workspaceId, canonicalOrders.connectionId, canonicalOrders.id], name: 'job_order_scope' }),
  foreignKey({ columns: [table.workspaceId, table.erpDestinationId], foreignColumns: [erpDestinations.workspaceId, erpDestinations.id], name: 'job_erp_scope' }),
]);

export const erpDispatches = pgTable('erp_dispatches', {
  workspaceId: workspaceId(), erpDestinationId: uuid('erp_destination_id').notNull(),
  externalIdempotencyKey: varchar('external_idempotency_key', { length: 300 }).notNull(),
  orderId: uuid('order_id').primaryKey(),
  state: varchar('state', { length: 20 }).$type<'PENDING' | 'PROCESSING' | 'CONFIRMED' | 'EXHAUSTED' | 'FAILED'>().notNull().default('PENDING'),
  payload: jsonb('payload').$type<JsonValue>().notNull(),
  attempts: integer('attempts').notNull().default(0), protocol: varchar('protocol', { length: 250 }),
  leaseUntil: utc('lease_until'), errorCode: varchar('error_code', { length: 100 }),
  createdAt: utc('created_at').defaultNow().notNull(), confirmedAt: utc('confirmed_at'),
}, table => [
  uniqueIndex('dispatch_scope_id').on(table.workspaceId, table.erpDestinationId, table.orderId),
  uniqueIndex('dispatch_external_key').on(table.erpDestinationId, table.externalIdempotencyKey),
  foreignKey({ columns: [table.workspaceId, table.orderId], foreignColumns: [canonicalOrders.workspaceId, canonicalOrders.id], name: 'dispatch_order_scope' }).onDelete('cascade'),
  foreignKey({ columns: [table.workspaceId, table.erpDestinationId], foreignColumns: [erpDestinations.workspaceId, erpDestinations.id], name: 'dispatch_erp_scope' }),
  check('erp_dispatch_attempts_budget', sql`${table.attempts} >= 0 AND ${table.attempts} <= 3`),
  check('dispatch_payload_key', sql`${table.payload} ? 'codigo_pedido' AND jsonb_typeof(${table.payload}->'codigo_pedido') = 'string' AND ${table.payload}->>'codigo_pedido' = ${table.externalIdempotencyKey}`),
]);

export const erpAttempts = pgTable('erp_attempts', {
  workspaceId: workspaceId(), erpDestinationId: uuid('erp_destination_id').notNull(),
  id: primaryId(), orderId: uuid('order_id').notNull(),
  ordinal: integer('ordinal').notNull(), httpStatus: integer('http_status'),
  outcome: varchar('outcome', { length: 30 }).notNull().default('STARTED'), durationMs: integer('duration_ms'),
  startedAt: utc('started_at').defaultNow().notNull(), finishedAt: utc('finished_at'),
}, table => [
  foreignKey({ columns: [table.workspaceId, table.erpDestinationId, table.orderId], foreignColumns: [erpDispatches.workspaceId, erpDispatches.erpDestinationId, erpDispatches.orderId], name: 'attempt_dispatch_scope' }).onDelete('cascade'),
  uniqueIndex('erp_attempt_ordinal_idx').on(table.orderId, table.ordinal), check('erp_attempt_ordinal_range', sql`${table.ordinal} BETWEEN 1 AND 3`),
]);

/** Explicit operator attestation; no automatic assignment during registration. */
export const legacyClaims = pgTable('legacy_claims', {
  id: primaryId(), workspaceId: workspaceId().unique(),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  replacedEmptyWorkspaceId: uuid('replaced_empty_workspace_id').notNull(),
  verificationReference: varchar('verification_reference', { length: 200 }).notNull(),
  claimedAt: utc('claimed_at').defaultNow().notNull(),
}, table => [check('legacy_claim_verification_nonempty', sql`length(btrim(${table.verificationReference})) >= 8`)]);
