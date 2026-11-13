import { CanonicalProductSchema, CanonicalStockMovementSchema } from '@omnihub/canonical-ir';
import { Elysia, t } from 'elysia';
import type { InventoryService } from '../services/inventory.service';

const query = t.Object({
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, default: 50 })),
  offset: t.Optional(t.Numeric({ minimum: 0, maximum: 2_147_483_647, default: 0 })),
});
const inventorySchema = t.Object({
  ...CanonicalProductSchema.properties,
  updatedAt: t.String({ format: 'date-time' }),
  availableStock: t.Integer({ minimum: 0 }),
});
const movementSchema = t.Object({
  ...CanonicalStockMovementSchema.properties,
  timestamp: t.String({ format: 'date-time' }),
});
const page = <T extends typeof inventorySchema | typeof movementSchema>(item: T) => t.Object({
  data: t.Array(item), limit: t.Integer(), offset: t.Integer(),
});

export const inventoryRoutes = (inventory: Pick<InventoryService, 'listInventory' | 'getLedger'>) => new Elysia({ prefix: '/api/v1/inventory' })
  .get('/', async ({ query }) => {
    const result = await inventory.listInventory(query.limit ?? 50, query.offset ?? 0);
    return { ...result, data: result.data.map((product) => ({ ...product, updatedAt: product.updatedAt.toISOString() })) };
  }, { query, response: { 200: page(inventorySchema) }, detail: { tags: ['Inventory'], security: [{ bearerAuth: [] }], summary: 'Consultar estoque canônico consolidado (operador local)' } })
  .get('/:sku/ledger', async ({ params, query }) => {
    const result = await inventory.getLedger(params.sku, query.limit ?? 50, query.offset ?? 0);
    return { ...result, data: result.data.map((movement) => ({ ...movement, timestamp: movement.timestamp.toISOString() })) };
  }, {
    params: t.Object({ sku: t.String({ minLength: 1, maxLength: 100 }) }),
    query, response: { 200: page(movementSchema) }, detail: { tags: ['Inventory'], security: [{ bearerAuth: [] }], summary: 'Consultar histórico de movimentações por SKU (operador local)' },
  });
