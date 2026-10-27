---
project: ominihub
type: agent-guide
status: active
created_at: "2026-10-27"
updated_at: "2026-10-27"
---

# Orientações para agentes — Omnihub

## Projeto e fontes de verdade

Hub de integração omnichannel estruturado no padrão Hub-and-Spoke com Representação Intermediária (IR) inspirada em compiladores. O sistema recebe notificações de marketplaces (Mercado Livre, Shopee e Amazon), normaliza para o modelo canônico, reserva estoque atomicamente contra overselling, despacha para o Mock ERP e projeta demanda via ARIMA.

- Repositório: `C:/Users/Felipe/Documents/Codes/Repositories/omnihub`.
- Cofre Obsidian: `C:/vault-agents/projects/ominihub/`.
- Leia o `README.md` do cofre, a spec do fluxo e a tarefa antes de implementar. As specs descrevem a arquitetura alvo da PoC; tarefas em `todo` são trabalho não executado.
- Diretrizes compartilhadas: `C:/vault-agents/shared/arch-guidelines.md` e `C:/vault-agents/shared/agent-prompts.md`.
- Confira `git status --short` antes de editar. Preserve alterações locais e arquivos não rastreados; não reverta trabalho preexistente.
- Verifique contratos no código quando documentação e implementação divergirem. Atualize a spec correspondente junto com mudanças de comportamento.

## Comandos e estrutura

Execute na raiz do monorepo (`apps/*` e `packages/*` geridos via Bun Workspaces com lockfile único).

```powershell
bun install
docker compose -f docker/docker-compose.yml up -d db
bun run db:generate
bun run db:migrate
bun run db:seed
bun run dev:api
bun run dev:web
bun run dev:mock
bun run dev:all
bun run typecheck
bun test
k6 run tests/stress/overselling-k6.js
```

As aplicações de desenvolvimento usam as portas 3000 (`hub-api`), 5173 (`web-dashboard`) e 3002 (`mock-erp`). Inicie cada servidor separado ou via `bun run dev:all`. Configure os `.env` a partir dos exemplos sem sobrescrever arquivos existentes.

- Banco e Drizzle Studio: `bun run db:generate`, `bun run db:migrate`, `bun run db:seed`, `bun run db:studio`.
- Previsão ARIMA via CLI: `python apps/ai-service/forecast.py "[{\"date\":\"2026-10-20\",\"quantity\":15}]"`.
- Não existe script de lint na raiz. Não relate lint como executado quando apenas `typecheck` foi realizado.

## BACKEND, IR E ADAPTADORES

Bun 1.4+, TypeScript 5.9, Elysia 1.4, schemas `t`/TypeBox, Drizzle ORM 0.45 e PostgreSQL 17 Alpine.

- Desacoplamento da IR: `apps/hub-api` e `packages/database` operam exclusivamente sobre `@omnihub/canonical-ir` (`CanonicalOrder`, `CanonicalProduct`, `CanonicalStockMovement`). Nenhuma nomenclatura proprietária de marketplace (`ordersn`, `order_items`, `ASIN`) deve vazar para fora de `packages/marketplace-adapters`.
- Dinheiro sempre em centavos inteiros não-negativos (`unitPriceCents`, `totalAmountCents`, `basePriceCents`). Converta valores externos na borda do parser com `Math.round(Number(val) * 100)`.
- Higienize documentos (`CPF`/`CNPJ`) e `postalCode` (`CEP`) mantendo apenas dígitos (`/\\D/g`). Normalize `state` (`UF`) para 2 letras maiúsculas sem prefixo `BR-`.
- Estoque e concorrência: reserve saldo em `InventoryService.reserveStock` com `UPDATE products ... WHERE id = $id AND (current_stock - reserved_stock - $safety) >=$qty RETURNING ...` dentro de `db.transaction`. Ordene `productId` lexicograficamente em pedidos multi-item para evitar deadlocks. Se faltar saldo em qualquer item, faça rollback total e retorne `409 INSUFFICIENT_CANONICAL_STOCK`.
- Idempotência e auditoria: valide `(source, external_order_id)` em `canonical_orders` (retornando `200 OK` sem nova baixa em duplicatas), salve o JSON original em `raw_payload` e grave toda movimentação em `inventory_ledger` na mesma transação.
- Proibido executar chamadas HTTP externas (`mock-erp` ou atualização de estoque nos spokes) dentro de `db.transaction`. Comite no PostgreSQL antes de iniciar o despacho.
- Webhooks (`/api/webhooks/:marketplace`): valide assinaturas criptográficas (`HMAC-SHA256` na Shopee, `SigV4` na Amazon) com `crypto.timingSafeEqual` sobre o corpo bruto antes do parser. Nunca exija Cloudflare Turnstile em rotas de webhook M2M.
- Mock ERP (`apps/mock-erp`, porta 3002): emula latência ($250\text{ ms}$–$600\text{ ms}$) e $5\%$ de erro `503`. O `ErpDispatchService` deve aplicar retry com exponential backoff + jitter (até 3 tentativas) mantendo a reserva ativa.

## FRONTEND

React 19, Vite 7, Tailwind CSS 4 e Lucide Icons em `apps/web-dashboard`.

- Centralize chamadas HTTP para `VITE_HUB_API_URL` com credenciais/cookies e tratamento padronizado de erros.
- Preserve as três visões operacionais exigidas na PoC: Overview de vazão/latência, Gestão Canônica de Estoque e Inspetor de 3 colunas do pipeline de compilação (*Raw JSON* $\rightarrow$ *IR Canônica* $\rightarrow$ *Payload ERP*).
- Proteja autenticação e ações sensíveis de navegador com `TurnstileWidget.tsx` validado no backend via `siteverify` e sessão JWT HttpOnly.
- Variáveis `VITE_*` são públicas no bundle; jamais exponha `CLOUDFLARE_TURNSTILE_SECRET_KEY`, `SHOPEE_PARTNER_KEY` ou `JWT_SECRET` no frontend.

## IA E EXPERIMENTOS (ARIMA & K6)

Microsserviço analítico em Python 3.12 (`apps/ai-service/forecast.py`) com `pandas` e `statsmodels`, e testes de carga em `tests/stress/`.

- O modelo $\text{ARIMA}(1, 1, 1)$ consome a série diária agregada de vendas (`reason = 'SALE'`) do `inventory_ledger` e projeta os próximos 7 dias. Trate séries históricas curtas retornando `503 ARIMA_INSUFFICIENT_HISTORY` sem interromper a API principal.
- O ensaio `tests/stress/overselling-k6.js` dispara 20 VUs simultâneos contra estoque inicial de 5 unidades (`safety_stock = 0`), devendo resultar exatamente em 5 respostas `201 Created`, 15 respostas `409 Conflict` e saldo final `0`.

## Qualidade, ambiente e entrega

- Mantenha `strict: true`, `noImplicitAny: true` e `strictNullChecks: true` a partir de `packages/tsconfig/base.json`. Não utilize `any` nos contratos de `@omnihub/canonical-ir` e `@omnihub/database`.
- Mantenha segredos fora do Git e do cofre. Documente placeholders em `.env.example` e `README.md`, nunca copie `.env` real.
- Testes que truncam tabelas ou manipulam saldos de concorrência exigem `TEST_DATABASE_URL` isolada, distinta de `DATABASE_URL`, contendo `test` ou `verify` no nome do banco.
- Para código alterado, execute `bun run typecheck` e `bun test` antes de concluir; valide migrations Drizzle quando alterar `schema.ts`.
- Registre tarefa, arquivos alterados e resultados reais de verificação em `C:/vault-agents/projects/ominihub/logs/`. Informe claramente verificações não executadas.
- Ciclo de vida de tarefas: ao iniciar uma tarefa, mova o arquivo de `tasks/todo/` para `tasks/in-progress/` e defina `status: "in-progress"`; ao concluir testes e logs, mova-o para `tasks/done/` com `status: "done"`.