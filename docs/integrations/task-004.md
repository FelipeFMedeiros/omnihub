# TASK-004 — Pipeline Mercado Livre, Mock ERP e operação local

O Hub oferece OAuth e notificações na porta **3000**, compatível com o túnel
HTTPS cadastrado pelo autor. O Mock ERP roda no loopback na **3002**. O pipeline
foi verificado com recursos Mercado Livre sintéticos e transporte injetado,
persistência PostgreSQL real e handlers Elysia do Mock ERP. O OAuth e a leitura
oficial de identidade do vendedor de teste também foram verificados. Um pedido
oficial, publicação de anúncio e atualização oficial de saldo ainda precisam
de cenário próprio; esses resultados não são inferidos a partir dos mocks.

## Executar

Na raiz do monorepo, com `.env` local já preparado:

```powershell
bun install
bun run setup:local
bun run docker:up
bun run db:migrate
bun run db:seed
```

`setup:local` gera somente credenciais locais ausentes: `HUB_ADMIN_TOKEN`,
`MOCK_ERP_ADMIN_TOKEN` e `ERP_WEBHOOK_SECRET`. Não imprime os valores nem
substitui credenciais existentes. São tokens de desenvolvimento; login/sessão
JWT/Turnstile do dashboard entram na TASK-005. Não coloque esses valores em
`VITE_*`, no Git, em logs ou no cofre.

Em terminais separados:

```powershell
bun run dev:mock
```

```powershell
bun run dev:api
```

Abra `http://localhost:3000/docs`. Nas operações administrativas, use o botão
**Authorize** com o `HUB_ADMIN_TOKEN` do `.env` local. As consultas antigas de
estoque continuam disponíveis; dados pessoais não são enviados pelo inspetor.
Para o catálogo visual, execute `bun run dev:ui` e abra `localhost:6006`.
O dashboard conectado continua na TASK-006.

## OAuth e contas de teste

`MELI_REDIRECT_URI` deve ser o valor exato registrado no DevCenter, terminado em
`/api/oauth/meli/callback`; o túnel encaminha para `localhost:3000`.

```powershell
# Com o Hub ativo:
bun run meli:authorize
# Abra a URL apresentada, confirme a conta e autorize.
bun run meli:smoke
```

O comando agora solicita ao Hub uma tentativa OAuth; não abre outro servidor.
O smoke também usa o Hub, mantendo um único escritor dos tokens do vendedor.
State, PKCE, expiração e consumo único da tentativa são verificados no callback.
Tentativas OAuth ficam em memória por dez minutos; reiniciar o Hub exige uma
nova tentativa. Tokens rotacionados são persistidos antes do uso, em arquivo
privado `output/meli/tokens.json`. A alternativa antiga chama-se
`authorize-standalone` e só pode ocupar a porta configurada com a API parada.

Para preparar contas quando não existirem, autorize primeiro a conta criadora:

```powershell
bun run meli:create-test-users
```

Esse comando faz POST explícito ao fluxo oficial, sem retry automático, e guarda
um vendedor/comprador em `output/meli/test-users.json`; reexecuções reutilizam
esse arquivo. Tokens iniciais da conta criadora são preservados privadamente em
`bootstrap-tokens.json`. Em seguida, entre com o vendedor e autorize novamente.
Esses arquivos contêm segredos e não fazem parte de evidências compartilhadas.
O usuário autorizou a criação das duas contas nesta entrega; ambas retornaram
ativas. O smoke final confirmou o vendedor como usuário de teste brasileiro.

## Contratos HTTP

As respostas de erro são `{ error: { code, message } }`, sem corpo externo/SQL.
Schemas e parâmetros executáveis estão no OpenAPI do Hub.

| Método e rota | Comportamento |
| --- | --- |
| `POST /api/oauth/meli/start` | Token admin; retorna URL e expiração da tentativa |
| `GET /api/oauth/meli/callback` | Retorno público com state; não aceita início de fluxo sem tentativa válida |
| `POST /api/oauth/meli/smoke` | Token admin; identidade de teste/leitura opcional usando o mesmo cliente do Hub |
| `POST /api/webhooks/meli` | Valida aviso orders_v2, app/vendedor/recurso; retorna 200 após inserir fila durável |
| `POST /api/webhooks/erp-stock` | HMAC-SHA256 no corpo bruto via `x-erp-signature`; movementId UUID, sku e quantity positiva |
| `GET /api/v1/dashboard/orders` | Pedidos sem PII; estados de reserva e despacho separados |
| `GET /api/v1/dashboard/processings` | Referências de execução, erros seguros e modo do transporte |
| `GET /api/v1/dashboard/processings/:id` | Snapshots Raw/IR/ERP mascarados, durações e tentativas |
| `POST /api/v1/dashboard/processings/:id/retry` | Cria nova execução sem alterar o trace antigo; não reinicia orçamento ERP esgotado |
| `GET/POST /api/v1/dashboard/mappings` | Consulta vínculos; cria mapeamento Mercado Livre de item/variação para produto |
| `GET /api/v1/dashboard/metrics` | Janela from/to ISO, até 31 dias; padrão últimas 24 horas |
| `GET /api/v1/dashboard/connections` | Última medição desta instância, ou UNKNOWN/NOT_IMPLEMENTED |
| `POST /api/v1/dashboard/connections/check` | Mede banco, saúde ERP e identidade de teste Mercado Livre |

Todas as rotas `/api/v1/dashboard/*` exigem token admin local. Listas usam
`limit` de 1 a 100 e `offset` não negativo; não informam total de páginas.
Snapshot é da execução persistida, sem nova tradução na leitura. Estado de
despacho e tentativas refletem o pedido ligado à execução. Cliente, endereço,
documento, telefone, e-mail e campos externos desconhecidos não são expostos.

Notificação Mercado Livre é aviso não confiável, não HMAC presumido. O worker
busca os recursos pelo host oficial com OAuth e valida os vínculos antes de
normalizar. Só processa a fila de seu canal e modo de transporte. O gateway
oficial exige vendedor de teste MLB, inclusive antes de publicar saldo; antes
do PUT verifica também o dono do anúncio. Não use transações entre conta real
e conta de teste.

## Fila, estoque e entrega

1. Persistir aviso em `pipeline_jobs`; reentrega exata no mesmo modo incrementa
   receiptCount e retorna a mesma referência, sem iniciar nova reserva.
2. Worker único da PoC reivindica uma execução, com lease de dois minutos e
   renovação. Reinício retoma jobs abandonados após expiração. Não implantar
   réplicas concorrentes para publicação de saldo nesta entrega.
3. Buscar recursos, resolver mapeamentos ativos e normalizar. A IR continua
   exigindo dados autorizados obrigatórios. Não inventar CPF/e-mail/endereço.
   Frete/descontos incompatíveis com total = soma dos itens são rejeitados.
   O primeiro pipeline exige PAID antes da reserva/despacho; pedidos pendentes
   geram ORDER_NOT_READY e um novo aviso de pagamento pode iniciar a ingestão.
4. Gravar pedido, reserva e SALE no commit transacional existente.
5. Publicar saldo vendável absoluto e emitir snapshot ERP fora da transação.
   Falha de sincronização não desfaz pedido confirmado nem libera reserva.
6. `erp_dispatches` preserva payload e orçamento; `erp_attempts` registra cada
   tentativa antes do HTTP. Até três chamadas totais, timeout de cinco segundos
   e duas esperas de 300/600 ms + jitter de 0–99 ms. Retry só para rede/429/5xx.
7. Confirmado protocolo, persistir recibo e, em outra transação, reduzir físico
   e reservado juntos, atualizar INVOICED e registrar FULFILLMENT com delta zero
   no saldo disponível. Uma reserva de duas unidades em físico cinco resulta
   em físico três, reservado zero e disponível três, sem desconto duplo.

Não há HTTP dentro de transação. Duplicatas usam o UUID/conteúdo originais.
Uma confirmação persistida pode ser finalizada sem novo HTTP. Esgotamento ou
erro permanente mantém a reserva e exige conciliação, sem quarta tentativa.
Se o processo cair após a última chamada sem persistir sua resposta, não há
garantia de conhecer o resultado externo; o orçamento não é reiniciado.
Cancelamento com despacho já iniciado também exige conciliação.
Cancelamento anterior ao despacho usa a referência do recurso autenticado para
liberar a reserva existente; não exige novamente PII que o marketplace ocultou.

Mapeamentos têm chave única canal + item + variação; variação vazia indica item
sem variação. Os nove IDs sintéticos do seed agora ficam desabilitados, inclusive
por migration nos registros antigos. Um anúncio real de teste precisa de vínculo
ativo cadastrado. Somente o gateway implementado publica saldo; outros canais
retornam NOT_IMPLEMENTED, sem falsos indicadores de conexão.

## Mock ERP

Estado em memória, perdido ao reiniciar. Catálogo inicial físico: fonte 20,
SSD 30 e memória 40 unidades. A idempotência do simulador dura apenas enquanto
essa instância estiver ativa; não reinicie o Mock ERP no meio de um ensaio.

| Rota na porta 3002 | Uso |
| --- | --- |
| `GET /health` | Saúde e quantidade de pedidos únicos processados |
| `POST /api/legacy/orders` | Contrato legado e baixa atômica/idempotente em memória |
| `GET /api/v1/erp/inventory` | Espelho do armazém |
| `POST /api/v1/erp/chaos-config` | minMs, maxMs, failureRate e sequência opcional de 200/503 |
| `POST /api/v1/erp/stock/adjust` | movementId, sku e delta positiva; notificação reversa assinada |

Exceto health, as operações exigem `MOCK_ERP_ADMIN_TOKEN`. Latência padrão
250–600 ms, falha 503 de 5%. Sequências determinísticas prevalecem sobre o
sorteio até esgotarem. Limites: 0–10000 ms, probabilidade 0–1 e até 100 passos.
Reenvio de pedido idêntico retorna o protocolo original sem nova baixa; conteúdo
divergente para a mesma chave retorna 409. Ajuste repetido com mesmo movementId
não soma novamente e pode retentar a notificação reversa.

## Métricas, retenção e evidência

Janela usa horário de recepção do processamento. Pedidos aceitos são IDs únicos
criados por essas execuções, não a soma de notificações. Taxa de entrega =
confirmados e faturados / aceitos não cancelados; pendentes/falhos permanecem no
denominador. Sem denominador, rate é null. Contagens separam reentregas exatas,
duplicatas de pedido, rejeições de negócio e falhas técnicas. failedProcessings
é o agregado dessas falhas, não uma contagem adicional de vendas. A taxa usa
o estado atual, em collectedAt, dos pedidos aceitos na janela de recepção.

Durações em milissegundos: fetch, parse, validação independente, reserva/DB,
emissão, ERP, sincronização e total. O parser também valida sua saída; parseMs
inclui essa validação, enquanto validationMs é a barreira independente do Hub.
erpMs inclui HTTP, backoff e confirmação local. Ausência de amostras é null;
não apresentar total/HTTP como benchmark puro de tradução.

Jobs/snapshots/tentativas persistem sem expurgo automático nesta PoC. Não há
promessa de retenção ilimitada em produção; limpeza somente em ambiente
isolado ou sob ação explícita do autor. Conectividade fica na memória da
instância e perde a medição no reinício. LOCAL_FIXTURE e OFFICIAL_TEST_USER
são identificados em trace e métricas; fixtures locais nunca são consumidas
pelo worker oficial.

Testes usam TEST_DATABASE_URL protegida, distinta do banco principal; limpam
somente UUIDs criados e nunca truncam tabelas. Evidências, revisões e verificações
finais estão no log TASK-004 do cofre; nenhum segredo ou credencial integra
o snapshot público. Não houve ensaio k6, benchmark de desempenho ou homologação
de marketplace nesta entrega.

## Verificação final — 2026-11-12

Typecheck de todos os workspaces aprovado; **177 testes, zero falhas**, 623
assertivas em 13 arquivos (25 casos adicionais em relação à TASK-003).
Migrations 0001/0002/0003 aplicadas e geração final sem diferenças de schema.
API real: health, docs, estoque, pedidos, processamentos, mapeamentos e métricas
retornaram 200; Mock ERP health e health pelo túnel público também retornaram 200.
Smoke oficial via Hub confirmou vendedor esperado, MLB e test_user, sem leitura
de pedido ou escrita de estoque oficial. Relatório sanitizado e snapshot do
fonte local não commitado preservados no log TASK-004 do cofre.
