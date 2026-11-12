import { Elysia, t } from 'elysia';
import { createHash, timingSafeEqual } from 'node:crypto';
import { decodeLegacyErpOrder, LegacyErpOrderSchema, signInternalBody, type LegacyErpOrderPayload } from '@omnihub/marketplace-adapters';

export interface ChaosConfig { minMs: number; maxMs: number; failureRate: number; sequence: (200 | 503)[] }
export interface MockErpOptions {
  adminToken: string; webhookSecret: string; hubWebhookUrl: string;
  warehouse?: ReadonlyMap<string, number>; chaos?: Partial<ChaosConfig>;
  sleep?: (ms: number) => Promise<void>; random?: () => number; transport?: typeof fetch;
}
export function validChaos(config: ChaosConfig): boolean {
  return Number.isInteger(config.minMs) && config.minMs >= 0 && Number.isInteger(config.maxMs) && config.maxMs >= config.minMs && config.maxMs <= 10000 && config.failureRate >= 0 && config.failureRate <= 1 && config.sequence.length <= 100 && config.sequence.every(s => s === 200 || s === 503);
}
export function createMockErp(options: MockErpOptions) {
  const warehouse = new Map(options.warehouse ?? [['SKU-FONTE-600W', 20], ['SKU-SSD-NVME-1TB', 30], ['SKU-MEM-DDR5-16GB', 40]]);
  const receipts = new Map<string, { digest: string; protocol: string }>();
  const adjustments = new Map<string, { sku: string; delta: number; balance: number; delivered: boolean }>();
  let config: ChaosConfig = { minMs: 250, maxMs: 600, failureRate: 0.05, sequence: [], ...options.chaos };
  if (!validChaos(config) || options.adminToken.length < 32 || options.webhookSecret.length < 32) throw new Error('Configure credenciais locais e parametros validos do Mock ERP.');
  const sleep = options.sleep ?? Bun.sleep, random = options.random ?? Math.random, transport = options.transport ?? fetch;
  const authorized = (header: string | null) => {
    const expected = Buffer.from(`Bearer ${options.adminToken}`), received = Buffer.from(header ?? '');
    return expected.length === received.length && timingSafeEqual(expected, received);
  };
  // Sem await entre checagem idempotente e baixa: commit síncrono em memória.
  const app = new Elysia().onError(({ code, status }) => status(code === 'NOT_FOUND' ? 404 : 422, { error: { code: 'MOCK_ERP_INVALID_REQUEST', message: 'Requisicao invalida.' } }))
    .get('/health', () => ({ status: 'ok', mode: 'in_memory_simulator', processedOrders: receipts.size }))
    .onBeforeHandle(({ request, status }) => {
      if (new URL(request.url).pathname !== '/health' && !authorized(request.headers.get('authorization'))) return status(401, { error: { code: 'UNAUTHORIZED', message: 'Credencial local exigida.' } });
    })
    .post('/api/legacy/orders', async ({ body, status }) => {
      let payload: LegacyErpOrderPayload;
      try { payload = decodeLegacyErpOrder(body); } catch { return status(422, { error: { code: 'INVALID_ERP_ORDER', message: 'Pedido legado invalido.' } }); }
      const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      const previous = receipts.get(payload.codigo_pedido);
      if (previous) return previous.digest === digest ? { status: 'SUCESSO', protocoloErp: previous.protocol, duplicate: true } : status(409, { error: { code: 'ERP_IDEMPOTENCY_CONFLICT', message: 'Pedido com outro conteudo.' } });
      const delay = config.minMs + Math.floor(random() * (config.maxMs - config.minMs + 1));
      const decision = config.sequence.shift() ?? (random() < config.failureRate ? 503 : 200);
      await sleep(delay);
      // Outra requisição pode ter confirmado enquanto esta aguardava a latência.
      const afterWait = receipts.get(payload.codigo_pedido);
      if (afterWait) return afterWait.digest === digest ? { status: 'SUCESSO', protocoloErp: afterWait.protocol, duplicate: true } : status(409, { error: { code: 'ERP_IDEMPOTENCY_CONFLICT', message: 'Pedido com outro conteudo.' } });
      if (decision === 503) return status(503, { error: { code: 'ERP_TEMPORARY_OUTAGE', message: 'Falha simulada.' } });
      const quantities = new Map<string, number>();
      for (const line of payload.itens_pedido) quantities.set(line.codigo_sku, (quantities.get(line.codigo_sku) ?? 0) + line.quantidade);
      if ([...quantities].some(([sku, qty]) => (warehouse.get(sku) ?? 0) < qty)) return status(409, { error: { code: 'ERP_INSUFFICIENT_STOCK', message: 'Saldo ERP insuficiente.' } });
      for (const [sku, qty] of quantities) warehouse.set(sku, warehouse.get(sku)! - qty);
      const protocol = `FAT-${crypto.randomUUID()}`;
      receipts.set(payload.codigo_pedido, { digest, protocol });
      return { status: 'SUCESSO', protocoloErp: protocol, duplicate: false };
    }, { body: LegacyErpOrderSchema })
    .get('/api/v1/erp/inventory', () => ({ warehouse: Object.fromEntries(warehouse) }))
    .post('/api/v1/erp/chaos-config', ({ body, status }) => {
      const candidate = { ...config, ...body };
      if (!validChaos(candidate)) return status(422, { error: { code: 'INVALID_CHAOS_CONFIG', message: 'Parametros de caos invalidos.' } });
      config = candidate; return { ...config };
    }, { body: t.Object({ minMs: t.Optional(t.Integer({ minimum: 0, maximum: 10000 })), maxMs: t.Optional(t.Integer({ minimum: 0, maximum: 10000 })), failureRate: t.Optional(t.Number({ minimum: 0, maximum: 1 })), sequence: t.Optional(t.Array(t.Union([t.Literal(200), t.Literal(503)]), { maxItems: 100 })) }) })
    .post('/api/v1/erp/stock/adjust', async ({ body, status }) => {
      let adjustment = adjustments.get(body.movementId);
      if (adjustment && (adjustment.sku !== body.sku || adjustment.delta !== body.delta)) return status(409, { error: { code: 'ERP_ADJUSTMENT_CONFLICT', message: 'Movimentacao divergente.' } });
      if (!adjustment) {
        const balance = (warehouse.get(body.sku) ?? 0) + body.delta;
        if (balance > 2147483647) return status(422, { error: { code: 'STOCK_LIMIT_EXCEEDED', message: 'Limite de estoque.' } });
        warehouse.set(body.sku, balance); adjustment = { sku: body.sku, delta: body.delta, balance, delivered: false }; adjustments.set(body.movementId, adjustment);
      }
      if (!adjustment.delivered) {
        const raw = JSON.stringify({ movementId: body.movementId, sku: body.sku, quantity: body.delta });
        try {
          const result = await transport(options.hubWebhookUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/json', 'x-erp-signature': signInternalBody(raw, options.webhookSecret) }, body: raw });
          adjustment.delivered = result.ok; await result.body?.cancel();
        } catch { /* Mesmo movementId permite retentar a notificação sem nova entrada física. */ }
      }
      return { status: 'AJUSTADO', sku: body.sku, saldoAtual: adjustment.balance, notificationDelivered: adjustment.delivered, movementId: body.movementId };
    }, { body: t.Object({ movementId: t.String({ format: 'uuid' }), sku: t.String({ minLength: 1, maxLength: 100 }), delta: t.Integer({ minimum: 1, maximum: 2147483647 }) }) });
  return app;
}
