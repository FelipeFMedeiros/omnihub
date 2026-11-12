import { createMockErp } from './app';
const port = Number(process.env.MOCK_ERP_PORT ?? 3002);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MOCK_ERP_PORT invalida.');
const hubWebhookUrl = process.env.HUB_ERP_WEBHOOK_URL ?? 'http://127.0.0.1:3000/api/webhooks/erp-stock';
const callback = new URL(hubWebhookUrl);
if (callback.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(callback.hostname) || callback.pathname !== '/api/webhooks/erp-stock') throw new Error('Callback ERP deve apontar ao Hub local.');
createMockErp({ adminToken: process.env.MOCK_ERP_ADMIN_TOKEN ?? '', webhookSecret: process.env.ERP_WEBHOOK_SECRET ?? '', hubWebhookUrl,
  chaos: { minMs: Number(process.env.MOCK_ERP_LATENCY_MS ?? 250), maxMs: Number(process.env.MOCK_ERP_MAX_LATENCY_MS ?? 600), failureRate: Number(process.env.MOCK_ERP_FAILURE_RATE ?? 0.05) },
}).listen({ hostname: '127.0.0.1', port });
console.log(`Mock ERP local em http://127.0.0.1:${port}`);
