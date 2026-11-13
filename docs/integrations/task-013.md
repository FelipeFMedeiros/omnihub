# TASK-013 — Isolamento por negócio e conexão

Implementação backend concluída após QA independente e integrada à `develop`
no commit `bc79b7b85948302798f08b92b4195de5304d06e1`, sobre a base
`75e25e9de6bb460a42c1257aae55dba4a76c5dfe`. A rodada final aprovou 245 testes,
zero falhas/skips e typecheck; migrations foram validadas em bancos dedicados.
Snapshots e logs permanecem no cofre após a remoção da worktree de implementação.

## Propriedade e contratos

O workspace da sessão vem do vínculo `users → workspaces` consultado no servidor.
`workspaceId` em JSON/query/header não autoriza uma sessão. O cadastro continua
criando um contexto vazio; não recebe os dados do seed/legado.

| Recurso | Identidade e integridade |
| --- | --- |
| Produtos | `workspace_id`; SKU único no negócio |
| Conexões | workspace, plataforma, identidade externa genérica, modo, estado; várias lojas do mesmo canal |
| Conta externa identificada | única por plataforma, inclusive entre modos e negócios; NULL somente em conexão desabilitada |
| Mapeamentos | workspace + conexão + item + variação; produto e canal precisam corresponder às FKs compostas |
| Pedidos | workspace + conexão + ID externo; MANUAL exige conexão NULL e índice parcial próprio |
| Ledger | workspace; produto, pedido e destino ERP do mesmo negócio |
| Fila | workspace + conexão + modo + fingerprint; pedido ligado pertence à mesma conexão |
| ERP | destino do workspace fixado no despacho; tentativas referenciam exatamente esse destino/pedido |

`WorkspaceContext`, `OrderContext` e `WorkerContext` são envelopes de serviços,
fora da IR. Nenhum campo de acesso/loja foi acrescentado a `CanonicalOrder` ou
`CanonicalStockMovement`. Valores monetários e validações da IR permanecem iguais.
Os IDs canônicos UUID continuam sendo gerados pelo Hub; IDs externos de pedidos
e itens podem coincidir entre lojas e negócios.

As FKs compostas também se aplicam a SQL direto. O banco rejeita origem MANUAL
com conexão, origem de canal sem conexão, canal incorreto, vínculos entre negócios,
destino de outro negócio e identidade externa duplicada. Serviços exigem workspace
aberto e conexões/destinos ativos; estado desabilitado não comprova conexão real.

## HTTP para TASK-006

[OpenAPI estático](task-013.openapi.json), gerado dos handlers, e `/docs/json`
publicam as rotas executáveis. `/health` continua público e mede somente o banco.

Todas as rotas `/api/v1/*` exigem sessão revogável HttpOnly ou manutenção CLI com
alvo explícito. Consultas de estoque/ledger, pedidos, processamentos/trace,
mappings, métricas e conectividade operam somente no workspace autorizado.
Objeto/SKU estrangeiro retorna 404 sem conteúdo. Pedidos, processamentos e traces
incluem `connectionId`; pedidos MANUAL retornam NULL. Snapshots continuam mascarados.

Mutações de navegador (`POST mappings`, `POST processings/:id/retry` e
`POST connections/check`) exigem:

- Cookie `omnihub_session`, com as mesmas flags e revogação da TASK-005.
- Origin permitido e `X-CSRF-Token` da sessão.
- `X-Turnstile-Token` novo, com action **domain_mutation** e cdata igual ao
  `csrfToken` da sessão no modo real. O modo dummy continua chamando siteverify.

Polling GET não chama siteverify. A criação de mapping exige `connectionId`,
`productId`, marketplace implementado e identificadores do anúncio; não aceita
URL ou credenciais. A conexão e o produto são autorizados individualmente.
CSRF/Origin/CORS, rate limiting e a política de proxy da TASK-005 permanecem ativos.

CLI: bearer `HUB_ADMIN_TOKEN` **e** `X-Workspace-Id: UUID` explícito. Header de
navegador Origin/Sec-Fetch-Site continua recusado mesmo com o bearer. Alvo ausente
retorna 422 `OPERATOR_WORKSPACE_REQUIRED`; o contexto legado fechado não é aberto
por esse token. Nunca colocar a credencial do operador no Scalar ou no frontend.

Conectividade lista registros do negócio, com IDs/estado/modo. Negócio vazio
recebe lista vazia. Sem binding/gateway medido, retorna NOT_CONFIGURED;
Amazon/Shopee sem implementação retornam NOT_IMPLEMENTED quando cadastrados.
O cache é por workspace e ID da conexão/destino, com horário; reinício perde a
medição. Métricas continuam usando janela de recepção e pedidos únicos, limitados
ao workspace; não são benchmark puro de tradução.

## Ingestão, worker e entrega

O adaptador resolve identidade externa; o Hub não interpreta nomes de vendedor
do payload. `/api/webhooks/meli` procura exatamente um gateway configurado que
valide app/conta/recurso. Ausência/ambiguidade retorna 403
`SPOKE_CONNECTION_UNRESOLVED`. O workspace alegado no aviso não define seu dono.
Mercado Livre continua aviso + consulta de recurso com OAuth e vínculos conferidos,
sem HMAC fabricado. Webhooks não exigem sessão, CSRF ou Turnstile.

Workers reivindicam jobs por workspace, conexão, canal, modo e destino ERP;
OFFICIAL_TEST_USER não consome LOCAL_FIXTURE. Gateway e registro devem identificar
a mesma conta externa. A lease de dois minutos/heartbeat e o token de posse
protegem atualizações do job. Retomada conserva namespace e orçamento.

Reserva/rollback multi-item mantêm ordem lexical e SQL condicional atômico.
Cancelamento usa o namespace da conexão. SALE continua sendo a reserva;
FULFILLMENT reduz físico/reservado juntos com delta disponível zero. Reposição
exige destino explícito. Nenhum HTTP é executado dentro de transação.

Novos despachos usam `oh:<workspaceUUID>:<connectionUUID>:<externalOrderId>` como
`codigo_pedido` externo; MANUAL usa o namespace `manual` quando emitido pelo
chamador. O emissor recebe essa chave fora da IR. Payload, chave e destino de
um despacho iniciado são imutáveis no SQL; o contador não pode ser reduzido.
São no máximo três envios totais. Resposta ambígua/exausta mantém a reserva;
retomada após a terceira tentativa STARTED não envia uma quarta chamada.
Confirmação persistida é finalizada sem reenviar nem repetir SALE/baixa física.

Publicação de saldo é serializada por instância de conexão. O registro de runtimes
publica nas lojas do mesmo workspace/modo, inclusive várias lojas do mesmo canal.
Locks/caches/clientes não são compartilhados entre conexões. Publicadores em
processos concorrentes continuam fora da homologação desta PoC; não implantar
réplicas de publicação sem coordenação distribuída adicional.

## Destinos permitidos e limite TASK-014

`erp_destinations` é cadastro do operador: `configKey`, origem HTTP loopback
canônica `http://127.0.0.1:PORTA`, estado e workspace. Um destino ativo por negócio.
Origem única impede compartilhar armazém/idempotência do Mock ERP entre negócios;
use instâncias ou transportes dedicados. Identidade/origem usada por despacho
não pode ser trocada. As chamadas também conferem origem/configKey do registro.

O operador pode informar `ERP_TARGETS_FILE` com um array JSON privado:

```json
[
  {
    "workspaceId": "UUID_DO_NEGOCIO",
    "erpDestinationId": "UUID_DO_DESTINO_CADASTRADO",
    "configKey": "chave-permitida-do-operador",
    "url": "http://127.0.0.1:PORTA_DEDICADA",
    "adminToken": "SEGREDO_PRIVADO_NOVO_COM_32_OU_MAIS_CARACTERES",
    "webhookSecret": "OUTRO_SEGREDO_PRIVADO_EXCLUSIVO_COM_32_OU_MAIS_CARACTERES"
  }
]
```

O runtime valida DB/estado/workspace/configKey/origem e exige endpoints/segredos
de callback distintos. Não existe endpoint para o navegador fornecer URL.
Callback: `POST /api/webhooks/erp-stock/:destinationId`; HMAC-SHA256 no corpo
bruto em `X-Erp-Signature`, antes do JSON. Somente `movementId`, `sku`, `quantity`
são aceitos. O destino resolve o workspace, com segredo exclusivo; uma assinatura
de A não funciona na rota de B. A rota antiga sem destino permanece fechada.

O runtime padrão **não lê o arquivo global de tokens nem inicializa OAuth/gateway
Mercado Livre**, mesmo se encontrar variáveis MELI antigas. `pipelines` é registro
injetável de bindings reais para serviços/testes; sua ausência é indisponibilidade,
nunca sucesso simulado. OAuth/token store por conexão e ativação de lojas/ERP pelo
usuário são TASK-014. O fluxo OAuth administrativo antigo não abre acesso ao domínio;
sem runtime explicitamente fornecido retorna MELI_NOT_CONFIGURED. Não importar
tokens do autor nem executar chamadas oficiais nesta tarefa.

## Migração e reivindicação do legado

Migrations 0005–0007, sobre 0004, criam `LEGACY_CLOSED` sem proprietário e sem
usuário/senha de bootstrap. Preservam os UUIDs e os campos históricos, incluindo
estoques/reservas, JSONs, protocolos/payloads ERP e tentativas. Conexões e destino
legados ficam desabilitados e sem credenciais/identidade externa presumidas.
Filas antigas preservam seu modo; a conexão legada desabilitada não é um worker
oficial/local ativo. O seed idempotente continua nesse contexto fechado, com
três produtos e nove mappings sintéticos desabilitados.

Reivindicação é somente uma operação explícita do operador, após verificar o
proprietário por meio independente. Não é verificação de e-mail implementada
pelo produto. O comando exige todos os alvos e referência da comprovação:

```powershell
bun run legacy:claim --legacy-workspace UUID_FECHADO --empty-workspace UUID_VAZIO_DA_CONTA --verified-owner UUID_VERIFICADO --verification-reference REFERENCIA_DA_COMPROVACAO --confirm-claim
```

A transação bloqueia os workspaces, valida vínculo e destino inteiramente vazio,
recusa mesclagem, remove o workspace vazio, atribui o **UUID histórico do legado**
ao proprietário e registra `legacy_claims`. Revoga sessões; o próximo login obtém
esse workspace. Não muda UUIDs de produtos/pedidos nem ativa conexões/credenciais.
Uma reivindicação não pode ser repetida. O operador ainda precisa conciliar o
destino ERP histórico antes de configurar a origem inicialmente desconhecida;
nunca alterar payload/chave já enviados. Nenhuma reivindicação em dados reais foi
executada; o teste utiliza uma transação sintética revertida.

## Reprodução de QA e evidências

O ambiente de validação utilizou `.env` privado com `omnihub_task013_dev` e
`omnihub_task013_test_db`; sem tokens Mercado Livre. Não copiar ao Git/cofre.
Não usar bancos TASK-005/principal, não recriar container/volume e não ocupar
3000/3002/6006. Os testes usam app.handle e sockets loopback em porta efêmera.

```powershell
bun install
# ATENÇÃO: este ensaio apaga SOMENTE os schemas do banco dedicado de teste,
# exigindo flag explícita e verificando nome/URL distinta antes de conectar.
bun --env-file=.env packages/database/scripts/verify-task013-upgrade.ts --reset-task013-test --fresh-after-upgrade
bun run db:generate
bun run db:migrate
bun run db:seed
bun run db:seed
bun run typecheck
bun test
bun run api:openapi
git diff --check
```

O upgrade compara todas as colunas anteriores de fixtures 0004 de auth e domínio,
incluindo reserva ativa, snapshots, confirmação/protocolo e três tentativas
esgotadas. Em seguida ensaia criação do zero, reaplicação e seed sem redefinir saldo.
A suíte mantém as regressões TASK-005; as antigas expectativas de 401 para uma
sessão comum foram atualizadas para contexto próprio vazio/404 de objeto estrangeiro.
Contagens e saídas efetivas ficam em `output/task-013`, junto ao handoff, OpenAPI,
snapshot exato e hashes. Não há lint configurado.

### Descoberta de testes com os artefatos presentes — QA-013-F01

O `bunfig.toml` da raiz configura `[test] pathIgnorePatterns = ["output/**"]`.
Assim, `bun test` puro mantém a descoberta dos testes reais em todo o monorepo
e ignora somente as saídas geradas, incluindo cópias `*.test.ts` nos snapshots.
Não é necessário mudar o script de teste, remover artefatos ou listar suítes.
O arquivo novo do QA, `apps/hub-api/tests/qa-task-013.test.ts`, continua incluído.

A opção está documentada na [configuração oficial do Bun](https://bun.com/docs/test/configuration#path-ignore-patterns)
e em [bunfig.toml](https://bun.com/docs/runtime/bunfig#testpathignorepatterns).
O help e a execução real no **Bun 1.4.0** foram usados para verificar suporte;
`coveragePathIgnorePatterns` não substitui a exclusão de descoberta.

Após gerar ou atualizar os artefatos em `output`, executar novamente na raiz:

```powershell
bun test
bun run typecheck
```

Essa verificação precisa ocorrer **depois do empacotamento**, com o snapshot
espelhado presente. Para a correção F01, não é necessário repetir reset/upgrade
ou migrations já revisados. Saídas antes/depois, códigos de saída, contagens e
fonte atualizado estão em `output/task-013/test-discovery-fix` e na pasta pública
`logs/evidences/task-013-2026-11-12/test-discovery-fix` do cofre; as rodadas dev/QA
anteriores permanecem preservadas. O QA confirmou a correção com `bun test` puro:
245 pass, zero fail/skip, 1792 assertivas em 19 arquivos reais, sem cópias de output.
Evidências dessa confirmação estão em `logs/evidences/task-013-2026-11-12/qa-final`.
Uma linha vazia extra no EOF do helper de upgrade foi removida posteriormente,
com prova binária sem mudança de lógica em `commit-format-fix`; a rodada QA
anterior não foi reclassificada como nova execução.

Limites: UI/TASK-006, ARIMA/TASK-007, conexões/OAuth/TASK-014, plataformas novas,
k6 e homologação pública/oficial não foram implementados ou executados aqui.
Para TASK-007, resolver SKU e agregar `inventory_ledger` com **workspace_id do
contexto autorizado**, produto do mesmo workspace e `reason='SALE'`; nunca agregar
SKU global nem incluir FULFILLMENT como venda. Cache futuro deve conter workspace,
produto e parâmetros do modelo. Ausência de previsão continua ausência de serviço;
não existe endpoint ou resultado ARIMA fictício nesta entrega.
