# Omnihub

Hub omnichannel com Representação Intermediária (IR), desenvolvido como PoC do TCC.
A TASK-001 entrega a fundação do monorepo: contratos canônicos com TypeBox,
persistência Drizzle ORM e PostgreSQL 17. A lógica de estoque, as integrações,
os serviços HTTP, o dashboard e a previsão ARIMA serão implementados nas próximas tarefas.

Pré-requisitos desta etapa: **Bun 1.4+**, **Docker** e **Docker Compose**.
TypeScript fica na série **5.9**, Drizzle ORM na **0.45** e Drizzle Kit na **0.31**.
Instale dependências apenas na raiz; `apps/*` e `packages/*` usam Bun Workspaces.
O lockfile único é `bun.lock`, formato textual padrão do [Bun](https://bun.com/docs/pm/lockfile).

```text
apps/                      Aplicações previstas nas TASK-002 a TASK-007
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
Os testes aplicam a migration nesse banco e revertem suas próprias fixtures por
transação; não truncam tabelas. A suíte cobre validação de contratos, restrições
relacionais, idempotência, JSON de auditoria e reexecução do seed sem redefinir saldo.
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
é obtido por junção com `products`. A reserva atômica e a escrita coordenada do
ledger pertencem à TASK-002.

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
| `bun run dev:api` | Reservado ao Hub API, porta 3000 (TASK-002) |
| `bun run dev:mock` | Reservado ao Mock ERP, porta 3002 (TASK-004) |
| `bun run dev:web` | Reservado ao dashboard, porta 5173 (TASK-006) |
| `bun run dev:all` | Iniciar os workspaces que possuírem script `dev` |

Os scripts `dev:*` ainda não iniciam aplicações nesta etapa.
Segredos de backend, como `JWT_SECRET`, `SHOPEE_PARTNER_KEY` e
`CLOUDFLARE_TURNSTILE_SECRET_KEY`, nunca devem usar prefixo `VITE_`, pois esse
prefixo torna a variável pública no bundle do futuro dashboard.
