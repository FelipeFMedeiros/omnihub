import { describe, expect, test } from 'bun:test';
import { createApp } from '../src/app';
import { OrderIngestionService } from '../src/services/order-ingestion.service';
import { databaseFixture, testDatabaseUrl } from './helpers';

describe.skipIf(!testDatabaseUrl)('API de estoque com PostgreSQL isolado', () => {
  const fixture = databaseFixture();
  const request = (path: string, init?: RequestInit) => createApp({ db: fixture.db }).handle(new Request(`http://localhost${path}`, init));

  test('health verifica conexão e docs expõem o contrato OpenAPI', async () => {
    const health = await request('/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok', database: 'connected' });
    const docs = await request('/docs');
    expect(docs.status).toBe(200);
    expect(docs.headers.get('content-type')).toContain('text/html');
    const schema = await request('/docs/json');
    expect(schema.status).toBe(200);
    const contract = await schema.json() as { paths: Record<string, unknown> };
    expect(contract.paths['/api/v1/inventory/']).toBeDefined();
    expect(contract.paths['/api/v1/inventory/{sku}/ledger']).toBeDefined();
  });

  test('consulta saldo consolidado com margem de segurança e datas ISO', async () => {
    const product = await fixture.product(5, 2);
    await new OrderIngestionService(fixture.db).ingest(fixture.order([{ sku: product.sku, quantity: 2 }]), {});
    const response = await request('/api/v1/inventory?limit=100');
    expect(response.status).toBe(200);
    const page = await response.json() as { data: { id: string; availableStock: number; currentStock: number; reservedStock: number; updatedAt: string }[] };
    const stored = page.data.find((entry) => entry.id === product.id);
    expect(stored).toMatchObject({ availableStock: 1, currentStock: 5, reservedStock: 2 });
    expect(new Date(stored!.updatedAt).toISOString()).toBe(stored!.updatedAt);
    const emptyPage = await request('/api/v1/inventory?offset=2147483647');
    expect(await emptyPage.json()).toMatchObject({ data: [] });
  });

  test('consulta histórico por SKU sem expor JSON ou dados de cliente', async () => {
    const product = await fixture.product();
    const order = fixture.order([{ sku: product.sku }]);
    await new OrderIngestionService(fixture.db).ingest(order, { privateOriginal: 'sensitive' });
    const response = await request(`/api/v1/inventory/${encodeURIComponent(product.sku)}/ledger?limit=10`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('sensitive');
    expect(text).not.toContain('test@example.com');
    expect(JSON.parse(text)).toMatchObject({ data: [{ sku: product.sku, orderId: order.id, reason: 'SALE', delta: -1, availableAfter: 4 }], limit: 10 });
    const missing = await request('/api/v1/inventory/UNKNOWN/ledger');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: 'CANONICAL_PRODUCT_NOT_FOUND' } });
  });

  test.each(['limit=0', 'limit=101', 'limit=1.5', 'offset=-1', 'offset=abc', 'offset=1.5'])('rejeita paginação inválida: %s', async (query) => {
    const response = await request(`/api/v1/inventory?${query}`);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: expect.any(String) } });
  });

  test('CORS permite origem configurada e não libera origem desconhecida', async () => {
    const approved = await request('/health', { headers: { origin: 'http://localhost:5173' } });
    expect(approved.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(approved.headers.get('access-control-allow-credentials')).toBe('true');
    const denied = await request('/health', { headers: { origin: 'https://unknown.example' } });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });
});
