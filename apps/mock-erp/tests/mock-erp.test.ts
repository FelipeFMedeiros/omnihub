import { expect, test } from 'bun:test';
import { createMockErp } from '../src/app';
const token = 'local-test-token-'.repeat(3), secret = 'local-test-secret-'.repeat(3);
const payload = { codigo_pedido: 'MERCADO_LIVRE-test-1', origem_canal: 'MERCADO_LIVRE', documento_cliente: '12345678901', cep_entrega: '01001000', uf_entrega: 'SP', valor_total: 2, itens_pedido: [{ codigo_sku: 'SKU', quantidade: 2, preco_unitario: 1 }] };
function request(path: string, body?: unknown, credential = token) { return new Request(`http://localhost${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
function app() { return createMockErp({ adminToken: token, webhookSecret: secret, hubWebhookUrl: 'http://localhost/api/webhooks/erp-stock', warehouse: new Map([['SKU', 5]]), chaos: { minMs: 0, maxMs: 0, failureRate: 0 }, sleep: async () => {} }); }
async function readJson(response: Response) { return await response.json() as { warehouse: Record<string,number>; notificationDelivered: boolean }; }
test('Mock ERP exige token nas operações, sem ecoar payload inválido', async () => {
  const erp = app();
  expect((await erp.handle(request('/health', undefined, ''))).status).toBe(200);
  expect((await erp.handle(request('/api/v1/erp/inventory', undefined, 'bad'))).status).toBe(401);
  const invalid = await erp.handle(request('/api/legacy/orders', { ...payload, valor_total: 3 }));
  expect(invalid.status).toBe(422); expect(await invalid.text()).not.toContain('12345678901');
});
test('Mock ERP deduplica pedidos concorrentes e rejeita reutilização divergente', async () => {
  const erp = app();
  const responses = await Promise.all(Array.from({ length: 8 }, () => erp.handle(request('/api/legacy/orders', payload))));
  const bodies = await Promise.all(responses.map(r => r.json() as Promise<{ protocoloErp: string }>));
  expect(new Set(bodies.map(r => r.protocoloErp)).size).toBe(1);
  expect((await readJson(await erp.handle(request('/api/v1/erp/inventory')))).warehouse.SKU).toBe(3);
  const changed = { ...payload, valor_total: 1, itens_pedido: [{ codigo_sku: 'SKU', quantidade: 1, preco_unitario: 1 }] };
  expect((await erp.handle(request('/api/legacy/orders', changed))).status).toBe(409);
});
test('Mock ERP faz rollback multi-item, controla 503 determinístico e valida caos', async () => {
  const erp = app();
  expect((await erp.handle(request('/api/v1/erp/chaos-config', { minMs: 10, maxMs: 1 }))).status).toBe(422);
  await erp.handle(request('/api/v1/erp/chaos-config', { sequence: [503, 200] }));
  expect((await erp.handle(request('/api/legacy/orders', payload))).status).toBe(503);
  expect((await erp.handle(request('/api/legacy/orders', payload))).status).toBe(200);
  const noStock = { ...payload, codigo_pedido: 'other', valor_total: 3, itens_pedido: [...payload.itens_pedido, { codigo_sku: 'UNKNOWN', quantidade: 1, preco_unitario: 1 }] };
  expect((await erp.handle(request('/api/legacy/orders', noStock))).status).toBe(409);
  expect((await readJson(await erp.handle(request('/api/v1/erp/inventory')))).warehouse.SKU).toBe(3);
});
test('reposição ERP mantém movementId e retenta callback sem nova entrada física', async () => {
  let calls = 0; const bodies: string[] = [];
  const erp = createMockErp({ adminToken: token, webhookSecret: secret, hubWebhookUrl: 'http://localhost/api/webhooks/erp-stock', warehouse: new Map([['SKU',5]]),
    transport: (async (_url: unknown, init?: RequestInit) => { calls++; bodies.push(String(init?.body)); expect(new Headers(init?.headers).get('x-erp-signature')).toHaveLength(64); return new Response('{}', { status: calls === 1 ? 503 : 200 }); }) as typeof fetch,
  });
  const body = { movementId: crypto.randomUUID(), sku: 'SKU', delta: 3 };
  expect((await readJson(await erp.handle(request('/api/v1/erp/stock/adjust', body)))).notificationDelivered).toBe(false);
  expect((await readJson(await erp.handle(request('/api/v1/erp/stock/adjust', body)))).notificationDelivered).toBe(true);
  expect((await readJson(await erp.handle(request('/api/v1/erp/inventory')))).warehouse.SKU).toBe(8);
  expect(bodies[0]).toBe(bodies[1]);
  expect((await erp.handle(request('/api/v1/erp/stock/adjust', { ...body, delta: 4 }))).status).toBe(409);
});
