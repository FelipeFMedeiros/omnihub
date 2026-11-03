# Omnihub

Hub omnichannel com Representação Intermediária (IR), desenvolvido como PoC do TCC.
As TASK-001 e TASK-002 entregam os contratos canônicos com TypeBox, persistência
Drizzle/PostgreSQL 17, Hub API em Elysia e motor transacional de estoque.
Adaptadores, despacho para ERP, segurança administrativa, dashboard e previsão
ARIMA estão previstos nas próximas tarefas.

Pré-requisitos desta etapa: **Bun 1.4+**, **Docker** e **Docker Compose**.
TypeScript fica na série **5.9**, Drizzle ORM na **0.45** e Drizzle Kit na **0.31**.
Instale dependências apenas na raiz; `apps/*` e `packages/*` usam Bun Workspaces.
O lockfile único é `bun.lock`, formato textual padrão do [Bun](https://bun.com/docs/pm/lockfile).

```text
apps/hub-api/              Elysia: estoque, ledger, saúde e OpenAPI (porta 3000)
packages/canonical-ir/     Interfaces, schemas TypeBox e validação semântica
packages/database/         Client, schema, migration, seed e testes de integração
packages/tsconfig/         TypeScript estrito compartilhado
docker/docker-compose.yml  PostgreSQL 17 Alpine com volume e healthcheck
```

## Preparar o ambiente

Execute na raiz do repositório, em PowerShell:

```powershell
bun install
if (!(Test-Path .env)) { Copy-Item .env.example .env }
bun run docker:up
bun run db:generate
bun run db:migrate
bun run db:seed
```

O `.env.example` contém somente credenciais locais e placeholders. O `.env` real
é ignorado pelo Git e nunca deve ser enviado ao repositório ou ao cofre.
Os scripts `db:*` e `docker:*` carregam explicitamente o `.env` da raiz.

O banco fica em `localhost:5432`, acessível apenas pelo loopback. Se essa porta
estiver ocupada ou reservada pelo Windows, altere `POSTGRES_PORT` no `.env`
(por exemplo, `55432`) e a porta nas duas URLs `DATABASE_URL` e `TEST_DATABASE_URL`.
Depois execute novamente `bun run docker:up`.

Para usar o Compose diretamente com as variáveis locais:

```powershell
docker compose --env-file .env -f docker/docker-compose.yml up -d --wait db
```

A migration inicial já está versionada em `packages/database/drizzle/`.
`db:generate` gera SQL quando o schema muda; não use `push` no lugar de migrations.
O seed é transacional e pode ser reexecutado: insere três SKUs e nove mapeamentos
sandbox (um por marketplace para cada SKU), preservando registros e saldos existentes.
Os identificadores externos do seed são fictícios.

## Verificações

```powershell
bun run typecheck
bun test
```

Os testes unitários não exigem banco. Os testes de integração só executam quando
`TEST_DATABASE_URL` está definida; sem ela, são marcados como ignorados.
O `.env.example` já define essa variável, portanto crie o banco isolado antes
de executar `bun test` se tiver copiado o exemplo:

```powershell
# Uma única vez, com os nomes e o usuário de desenvolvimento do exemplo:
docker compose --env-file .env -f docker/docker-compose.yml exec -T db createdb -U omnihub omnihub_test_db
bun test
```

O destino deve ser distinto de `DATABASE_URL`, com `test` ou `verify` no nome
do banco. A proteção é verificada antes de conectar ou aplicar migrations.
Os testes aplicam a migration nesse banco. A camada de persistência reverte suas
fixtures por transação; os ensaios concorrentes usam commits e conexões reais e
removem somente os UUIDs que criaram. Não há truncamento de tabelas.
A suíte cobre contratos, restrições relacionais, idempotência, JSON de auditoria,
seed, rollback multi-item, cancelamentos, reposições e API HTTP. O ensaio de 15
reservas sobre 5 unidades exige exatamente 5 sucessos e 10 conflitos.
Não há script de lint configurado nesta etapa.

## Contratos e persistência

Importe interfaces, schemas e `isCanonicalOrder` de `@omnihub/canonical-ir`.
Valores monetários são inteiros não negativos em centavos; documentos e CEP
devem chegar sem pontuação, e a UF deve conter duas letras maiúsculas.
Os schemas rejeitam campos extras e não fazem sanitização. Ela pertence à borda
dos futuros adaptadores. `createdAt`, `updatedAt` e `timestamp` são objetos `Date`
na IR em memória; as bordas devem converter as datas do JSON antes de validar.

`CanonicalOrderSchema` valida a estrutura. `isCanonicalOrder` também exige que
`totalAmountCents` corresponda à soma de preço × quantidade, com aritmética de
inteiros seguros. Frete e descontos ainda não têm campos próprios neste contrato.

```typescript
import { createDatabase, products } from '@omnihub/database';

const { db, client } = createDatabase();
try {
  const catalog = await db.select().from(products);
  console.log(catalog);
} finally {
  await client.end();
}
```

O pacote de banco não conecta durante a importação. `createDatabase` lê
`DATABASE_URL` e `DATABASE_POOL_SIZE` (padrão 20), ou recebe URL e tamanho do pool
como argumentos. O chamador é responsável por encerrar o client.

As quatro tabelas são `products`, `spoke_mappings`, `canonical_orders` e
`inventory_ledger`. As chaves primárias UUID v7 são geradas pelo Bun nos inserts
Drizzle; inserts SQL diretos precisam fornecer o ID. Timestamps usam fuso horário.
Dinheiro e quantidades no PostgreSQL usam `integer` (limite de 2.147.483.647).
Os índices únicos protegem SKU, `(marketplace, external_item_id)` e
`(source, external_order_id)`. Restrições `CHECK` impedem valores negativos e
enumerações desconhecidas no banco.

Pedidos preservam os itens canônicos em `items_payload` e o JSON original em
`raw_payload`; o ledger guarda `available_after` (físico menos reservado), além
de delta, motivo, produto, pedido opcional e timestamp. `sku` da movimentação
é obtido por junção com `products`.

## Hub API e motor de estoque

```powershell
bun run dev:api
# Em outro terminal:
Invoke-RestMethod http://localhost:3000/health
Invoke-RestMethod 'http://localhost:3000/api/v1/inventory?limit=50&offset=0'
Invoke-RestMethod http://localhost:3000/api/v1/inventory/SKU-FONTE-600W/ledger
```

Documentação Scalar em `http://localhost:3000/docs`, contrato OpenAPI em
`/docs/json`. O servidor verifica `DATABASE_URL`, pool, host, porta e origens CORS
ao iniciar. `/health` consulta o PostgreSQL e retorna 503 quando ele está indisponível.
As consultas usam `limit` de 1 a 100 (padrão 50), `offset` não negativo (padrão 0)
e retornam `{ data, limit, offset }`, com datas ISO. Histórico de SKU desconhecido
retorna 404. Erros seguem `{ error: { code, message } }`, sem expor SQL ou segredos.

`currentStock` é o saldo físico. A reserva aumenta somente `reservedStock`;
o disponível público é `max(0, currentStock - reservedStock - safetyStock)`.
O `UPDATE ... WHERE ... RETURNING` verifica esse saldo e reserva atomicamente.
Com estoque físico 5, reservado 0 e margem 0, cinco vendas deixam físico 5,
reservado 5 e **disponível 0**. Reduzir o físico e aumentar o reservado na mesma
reserva descontaria o disponível duas vezes. O faturamento físico é integrado na TASK-004.

`OrderIngestionService.ingest(order, rawPayload)` recebe somente IR normalizada.
Na mesma transação, insere o pedido, resolve os SKUs, agrega itens repetidos,
reserva produtos em ordem lexical de UUID e grava `SALE` no ledger. Qualquer
falta de saldo reverte o pedido inteiro com `409 INSUFFICIENT_CANONICAL_STOCK`.
`ON CONFLICT` pela origem e identificador externo resolve também duplicatas
simultâneas: a primeira criação retorna `status: 201`; as demais retornam o
pedido original com `status: 200` e `duplicate: true`, preservando o JSON inicial.
Esses valores são recibos do serviço para os futuros handlers HTTP de webhook.

`InventoryService.reserveStock(productId, quantity, orderId)` permite reservar
contra um pedido já persistido; repetições do mesmo pedido/produto/quantidade
reutilizam a movimentação. A margem de segurança é aplicada por padrão, com
parâmetro explícito para experimentos controlados. A ingestão aceita novos
pedidos `PENDING`/`PAID` e valida os limites de `integer` do PostgreSQL.

`OrderIngestionService.cancel(source, externalOrderId)` libera todas as reservas
de um pedido pendente/pago e registra deltas positivos `CANCELLATION`, com
idempotência e rollback integral. `InventoryService.restock(productId, quantity,
movementId)` repõe estoque físico e grava `ERP_SYNC`; o chamador deve reutilizar
o mesmo UUID canônico de movimentação nas retentativas do mesmo evento.

As transações usam Read Committed, timeout de lock de 2 segundos e até duas
retentativas com backoff/jitter somente para falhas transitórias de contenção.
A API responde 503 quando a contenção persiste. Nenhuma chamada HTTP externa
acontece dentro dessas transações. A reavaliação do predicado após locks
concorrentes segue o comportamento documentado do
[PostgreSQL 17](https://www.postgresql.org/docs/17/transaction-iso.html).

Nesta etapa, a superfície HTTP oferece saúde, documentação e consultas. Os
serviços de ingestão, cancelamento e reposição serão conectados aos webhooks
nas tarefas seguintes, junto aos parsers e validações criptográficas.

## Comandos disponíveis

| Comando | Finalidade |
| --- | --- |
| `bun run docker:up` | Subir o PostgreSQL com volume persistente |
| `bun run docker:logs` | Acompanhar logs do banco |
| `bun run docker:down` | Parar o Compose, preservando o volume |
| `bun run db:generate` | Gerar migration a partir do schema |
| `bun run db:migrate` | Aplicar migrations na `DATABASE_URL` |
| `bun run db:seed` | Inserir catálogo e mapeamentos sandbox |
| `bun run db:studio` | Abrir o Drizzle Studio |
| `bun run typecheck` | Verificar tipos de todos os pacotes implementados |
| `bun test` / `bun run test` | Executar a suíte Bun |
| `bun run dev:api` | Iniciar Hub API com watch, porta 3000 |
| `bun run dev:mock` | Reservado ao Mock ERP, porta 3002 (TASK-004) |
| `bun run dev:web` | Reservado ao dashboard, porta 5173 (TASK-006) |
| `bun run dev:all` | Iniciar os workspaces que possuírem script `dev` |

O watch da API roda a partir da raiz e acompanha também os pacotes compartilhados.
Os scripts de Mock ERP e dashboard dependem das próximas tarefas.
Segredos de backend, como `JWT_SECRET`, `SHOPEE_PARTNER_KEY` e
`CLOUDFLARE_TURNSTILE_SECRET_KEY`, nunca devem usar prefixo `VITE_`, pois esse
prefixo torna a variável pública no bundle do futuro dashboard.
