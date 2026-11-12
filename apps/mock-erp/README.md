# Mock ERP

Simulador Elysia em memória, porta 3002 de loopback. Requer tokens locais gerados
por `bun run setup:local`; inicie na raiz com `bun run dev:mock`.

Contratos de pedidos, reposição assinada, idempotência, caos e limites de retenção
no [guia do pipeline](../../docs/integrations/task-004.md). Estado e recibos são
perdidos ao reiniciar o simulador. Não reinicie no meio de um ensaio.
