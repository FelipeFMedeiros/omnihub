# Aplicações

`hub-api` (TASK-002/004) executa na porta 3000: estoque/ledger, fila e pipeline,
OAuth, webhooks, consultas de pedidos/trace/métricas e OpenAPI. Inicie com
`bun run dev:api` na raiz.

`mock-erp` (TASK-004) executa no loopback na porta 3002, com memória local,
idempotência, latência e falhas controladas. Inicie com `bun run dev:mock`.
Preparação e contratos: `docs/integrations/task-004.md` na raiz do repositório.

Workspaces previstos: `web-dashboard` (TASK-006) e Python `ai-service` (TASK-007).
