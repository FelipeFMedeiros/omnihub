# Omnihub

O [design system](packages/ui/README.md) está disponível no catálogo interativo
em **http://localhost:6006**, com `bun run dev:ui`. Inclui temas claro/escuro,
fundamentos da marca, componentes e padrões responsivos. A TASK-009 entrega
essa base visual; a TASK-006 integrará o dashboard aos contratos reais da API.

Hub omnichannel com Representação Intermediária (IR), desenvolvido como PoC do TCC.
As TASK-001 e TASK-002 entregam os contratos canônicos com TypeBox, persistência
Drizzle/PostgreSQL 17, Hub API em Elysia e motor transacional de estoque.
A TASK-003 entrega o [adaptador Mercado Livre](packages/marketplace-adapters/README.md),
com parser puro, cliente de leitura e helper OAuth. A TASK-004 conecta a fila
durável, reserva, Mock ERP e sincronização de saldo, com consultas operacionais.
Veja o [guia do pipeline](docs/integrations/task-004.md). A TASK-005 implementa
[conta, sessão HttpOnly, Turnstile e proteção de borda](docs/integrations/task-005.md).
TASK-013 implementa [isolamento por negócio e conexão](docs/integrations/task-013.md)
no backend, aprovada pelo QA independente com 245 testes. Sessões acessam somente seu workspace;
o legado permanece fechado, sem dono e sem herança no cadastro. TASK-014 acrescenta
[conexões Mercado Livre por negócio](docs/integrations/task-014.md), OAuth com
confirmação pela sessão, credenciais criptografadas, simulação local e seleção de
ERP permitido. A TASK-014 foi aprovada pelo QA independente com 279 testes,
zero falhas/skips, tipagem e migrações verificadas em bancos isolados.
Interface operacional, ARIMA e os demais canais
entram nas próximas tarefas.

Pré-requisitos desta etapa: **Bun 1.4+**, **Docker** e **Docker Compose**.
TypeScript fica na série **5.9**, Drizzle ORM na **0.45** e Drizzle Kit na **0.31**.
Instale dependências apenas na raiz; `apps/*` e `packages/*` usam Bun Workspaces.
O lockfile único é `bun.lock`, formato textual padrão do [Bun](https://bun.com/docs/pm/lockfile).

```text
apps/hub-api/              Elysia: estoque, ledger, saúde e OpenAPI (porta 3000)
apps/mock-erp/             ERP em memória: faturamento, reposição e caos (porta 3002)
packages/canonical-ir/     Interfaces, schemas TypeBox e validação semântica
packages/database/         Client, schema, migration, seed e testes de integração
packages/marketplace-adapters/ Parser Mercado Livre, schemas, OAuth e leitura oficial
packages/ui/               Tokens, componentes React e catálogo Storybook (6006)
packages/tsconfig/         TypeScript estrito compartilhado
docker/docker-compose.yml  PostgreSQL 17 Alpine com volume e healthcheck
```

## Preparar o ambiente

Execute na raiz do repositório, em PowerShell:

```powershell
bun install
if (!(Test-Path .env)) { Copy-Item .env.example .env }
bun run setup:local
bun run docker:up
bun run db:generate
bun run db:migrate
bun run db:seed
```

O `.env.example` contém somente credenciais locais e placeholders. O `.env` real
é ignorado pelo Git e nunca deve ser enviado ao repositório ou ao cofre.
Os scripts `db:*` e `docker:*` carregam explicitamente o `.env` da raiz.

O exemplo publica o banco em `127.0.0.1:55432`, acessível apenas pelo loopback;
dentro do contêiner, o PostgreSQL continua na porta `5432`. Se a porta do host
estiver ocupada ou reservada pelo Windows, altere `POSTGRES_PORT` no `.env`
(por exemplo, `55433`) e a porta nas duas URLs `DATABASE_URL` e `TEST_DATABASE_URL`.
Depois execute novamente `bun run docker:up`.

Para usar o Compose diretamente com as variáveis locais:

```powershell
docker compose --env-file .env -f docker/docker-compose.yml up -d --wait db
```

A migration inicial já está versionada em `packages/database/drizzle/`.
`db:generate` gera SQL quando o schema muda; não use `push` no lugar de migrations.
O seed é transacional e pode ser reexecutado: insere três SKUs e nove mapeamentos
sandbox (um por marketplace para cada SKU), preservando registros e saldos existentes.
Os identificadores externos do seed são fictícios e seus vínculos ficam com
sincronização desabilitada. Cadastre os anúncios de teste reais separadamente.

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

## Design system e catálogo visual

Execute na raiz, com Bun e Node 20.19+ ou 22.12+ instalados:

```powershell
bun install
bun run dev:ui
# Abra http://localhost:6006
```

Navegue pelo menu lateral ou pela busca. Alterne Sistema/Claro/Escuro, abra
os exemplos de componentes e teste os padrões de overview, estoque e pipeline.
Há controles de propriedades e viewport, exemplos de código e links diretos
por história para revisão. O catálogo usa fixtures identificadas e funciona
sem API, PostgreSQL, ERP ou arquivos `.env`.

```powershell
bun run build:ui
bun run preview:ui
# Serve o build em localhost:6006; pare dev:ui antes de usar essa porta.
bun run test:ui
```

Os testes de interface usam Playwright e Google Chrome instalado, incluindo
interações, teclado, axe, contraste e reflow. O build estático fica em
`packages/ui/storybook-static/`. Veja a [API e guia de uso](packages/ui/README.md)
e as [diretrizes do design system](docs/design-system/plan.md).

## Contratos e persistência

Importe interfaces, schemas e `isCanonicalOrder` de `@omnihub/canonical-ir`.
Valores monetários são inteiros não negativos em centavos; documentos e CEP
devem chegar sem pontuação, e a UF deve conter duas letras maiúsculas.
Os schemas rejeitam campos extras e não fazem sanitização. Ela pertence à borda
dos adaptadores. `createdAt`, `updatedAt` e `timestamp` são objetos `Date`
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

As tabelas de domínio são `products`, `spoke_mappings`, `canonical_orders` e
`inventory_ledger`; `pipeline_jobs`, `erp_dispatches` e `erp_attempts` guardam fila,
snapshots, entrega e orçamento de tentativas. As chaves UUID v7 são geradas pelo Bun nos inserts
Drizzle; inserts SQL diretos precisam fornecer o ID. Timestamps usam fuso horário.
Dinheiro e quantidades no PostgreSQL usam `integer` (limite de 2.147.483.647).
Os índices únicos protegem SKU por workspace, item/variação por conexão e
pedido externo por conexão; MANUAL possui índice parcial próprio com conexão NULL.
FKs compostas impedem referências entre negócios. Restrições `CHECK` impedem valores negativos e
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
# Estoque/ledger usam a sessão e seu workspace; CLI exige bearer + X-Workspace-Id.
# Nunca inserir HUB_ADMIN_TOKEN no navegador. Contrato: docs/integrations/task-013.md.
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

Os serviços recebem contexto confiável no construtor, fora da IR.
`OrderIngestionService.ingest(order, rawPayload)` recebe somente IR normalizada.
Na mesma transação, insere o pedido, resolve os SKUs, agrega itens repetidos,
reserva produtos em ordem lexical de UUID e grava `SALE` no ledger. Qualquer
falta de saldo reverte o pedido inteiro com `409 INSUFFICIENT_CANONICAL_STOCK`.
`ON CONFLICT` pelo workspace/conexão e identificador externo (índice próprio para MANUAL) resolve também duplicatas
simultâneas: a primeira criação retorna `status: 201`; as demais retornam o
pedido original com `status: 200` e `duplicate: true`, preservando o JSON inicial.
Esses valores são recibos internos do serviço. O webhook da TASK-004 confirma
somente a gravação na fila com 200; o resultado é consultado por processingId.

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

O webhook Mercado Livre persiste o aviso antes de responder 200; um worker
consulta o recurso autorizado e executa o pipeline. OAuth compartilha a porta
3000 com a API. O callback ERP exige HMAC no corpo bruto. Consulte os contratos,
tokens administrativos locais, estados e limites no [guia da TASK-004](docs/integrations/task-004.md).
Os handlers executáveis e suas consultas estão em `/docs`.

## Mercado Livre — autorização e leitura

Desde TASK-013, o runtime padrão mantém a integração global desabilitada e não
importa tokens de vendedor. A TASK-014 acrescenta OAuth/credenciais por conexão,
com opt-in e custódia descritos no [guia próprio](docs/integrations/task-014.md);
os comandos abaixo descrevem o fluxo administrativo histórico das TASK-003/004.
Preencha os placeholders `MELI_*` somente no `.env` local. O OAuth da aplicação
Omnihub é separado do login do MCP. O Mercado Livre usa usuários de teste no
ambiente oficial, sem sandbox isolado. O [guia do adaptador](packages/marketplace-adapters/README.md)
explica redirect exato, encaminhamento HTTPS, PKCE e persistência privada de tokens.

```powershell
bun run meli:authorize
bun run meli:smoke
# Opcional, depois de verificar a conta de teste:
bun run meli:smoke --order-id ID_DO_PEDIDO_DE_TESTE
```

O smoke exige vendedor brasileiro com tag `test_user` e salva relatório
sanitizado em `output/task-003/`. Não cria usuários/pedidos e não confirma sozinho
a normalização completa. Testes locais do parser/cliente não precisam de
credenciais: `bun test packages/marketplace-adapters/tests`.

## Comandos disponíveis

| Comando | Finalidade |
| --- | --- |
| `bun run docker:up` | Subir o PostgreSQL com volume persistente |
| `bun run setup:local` | Gerar tokens de desenvolvimento ausentes sem imprimi-los |
| `bun run docker:logs` | Acompanhar logs do banco |
| `bun run docker:down` | Parar o Compose, preservando o volume |
| `bun run db:generate` | Gerar migration a partir do schema |
| `bun run db:migrate` | Aplicar migrations na `DATABASE_URL` |
| `bun run db:seed` | Inserir catálogo e mapeamentos sandbox |
| `bun run db:studio` | Abrir o Drizzle Studio |
| `bun run typecheck` | Verificar tipos de todos os pacotes implementados |
| `bun test` / `bun run test` | Executar a suíte Bun |
| `bun run dev:api` | Iniciar Hub API com watch, porta 3000 |
| `bun run dev:mock` | Iniciar o Mock ERP em memória, porta 3002 |
| `bun run dev:web` | Reservado ao dashboard, porta 5173 (TASK-006) |
| `bun run dev:ui` | Abrir catálogo interativo do design system, porta 6006 |
| `bun run build:ui` | Gerar catálogo estático em packages/ui/storybook-static |
| `bun run preview:ui` | Servir localmente o catálogo compilado, porta 6006 |
| `bun run test:ui` | Verificar interação e acessibilidade no Chrome headless |
| `bun run meli:authorize` | Autorizar a aplicação no helper OAuth local |
| `bun run meli:create-test-users` | Criar/reutilizar contas de teste após autorização inicial explícita |
| `bun run meli:smoke` | Verificar conta de teste e leitura oficial explícita |
| `bun run dev:all` | Iniciar os workspaces que possuírem script `dev` |

O watch da API roda a partir da raiz e acompanha também os pacotes compartilhados.
O script do dashboard depende da TASK-006. O `.env.example` separa configurações
atuais das futuras. O pipeline usa `MOCK_ERP_*` e os tokens locais; JWT/Turnstile
serão configurados na TASK-005. Shopee será simulada localmente, sem chave oficial.
O catálogo de UI não precisa de `.env`. Para Mercado Livre, o redirect é uma URL
de retorno cadastrada por você, o vendedor é o ID de um usuário de teste criado
pelo fluxo oficial e o refresh é obtido no OAuth, não copiado do DevCenter/MCP.
Segredos de backend, como `JWT_SECRET`, `SHOPEE_PARTNER_KEY` e
`CLOUDFLARE_TURNSTILE_SECRET_KEY`, nunca devem usar prefixo `VITE_`, pois esse
prefixo torna a variável pública no bundle do futuro dashboard.
