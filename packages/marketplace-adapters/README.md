# Adaptadores do Omnihub — TASK-003

Esta entrega contém a interface `SpokeAdapter`, schemas de leitura e o primeiro
parser Mercado Livre → `CanonicalOrder`. O cliente HTTP e o helper OAuth são
independentes do MCP. Amazon e Shopee pertencem às TASK-011/012; fila, ingestão HTTP,
estoque e despacho ERP estão conectados pela TASK-004.

## Parser sem rede

```typescript
import { parseMeliOrderToCanonical } from '@omnihub/marketplace-adapters';

const canonical = parseMeliOrderToCanonical(
  { order: rawOrder, shipment: rawShipment, billingInfo: rawBillingInfo, buyerProfile: authorizedBuyerProfile },
  {
    canonicalOrderId: idGeneratedByTheCaller,
    expectedSellerId: configuredSellerId,
    skuMappings: [{ itemId: 'MLB1234567890', variationId: '12345', sku: 'SKU-CANONICO' }],
  },
);
```

As variáveis do exemplo são entradas do chamador. Recursos complementares são
opcionais somente quando os dados obrigatórios já estiverem disponíveis no pedido.
O parser não cria UUID, não lê relógio, banco, variáveis de ambiente ou rede.
Usa o ID fornecido pelo chamador e valida a IR com `isCanonicalOrder`.

- Preços e total são arredondados na borda com `Math.round(Number(v) * 100)`.
  O total precisa corresponder à soma dos itens. Frete, descontos e ajustes que
  não caibam nessa igualdade são rejeitados, sem distribuição artificial.
- CPF/CNPJ e CEP ficam somente com dígitos; UF perde `BR-` e fica em maiúsculas.
  A validação canônica atual confere formato/comprimento, não dígitos verificadores.
- SKU vem do mapeamento explícito de item **e variação**. `seller_sku` não é uma
  chave canônica confiável. Uma variação não herda o mapeamento do item base.
- E-mail, documento, nome e endereço exigidos pela IR não são inventados.
  Recursos atuais podem omitir e-mail mesmo após consulta ao faturamento.
  `buyerProfile` é uma entrada suplementar autorizada do mesmo comprador,
  **não** uma promessa de que `/users/:id` forneça e-mail a qualquer aplicação.
  Dados insuficientes geram `ADAPTER_ENRICHMENT_REQUIRED` ou falha semântica
  quando presentes, mas inválidos. Alterar a obrigatoriedade na IR exige decisão
  explícita no próximo pipeline.
- IDs inteiros seguros viram strings. IDs maiores devem chegar como strings;
  números JSON acima de `Number.MAX_SAFE_INTEGER` são rejeitados para evitar
  perda silenciosa de precisão. Datas exigem horário e fuso válidos.
- Estados aceitos: `paid` → `PAID`; `confirmed`, `payment_required`,
  `payment_in_process`, `partially_paid` → `PENDING`; `cancelled` → `CANCELLED`.
  Estados desconhecidos são rejeitados. A tradução não baixa nem reserva estoque;
  transições de cancelamento serão encaminhadas pelo futuro orquestrador.

## Notificação e consulta são etapas distintas

`parseMeliOrderNotification` aceita apenas `orders_v2`, app/vendedor esperados e
recurso `/orders/<ID>`. Isso valida um aviso, **não autentica sua origem**.
O cliente consulta o pedido pelo host oficial com OAuth e verifica os vínculos
de vendedor/comprador/entrega/faturamento. Nunca busca uma URL recebida no webhook.
Não há HMAC Mercado Livre presumido nem `signature.ts` fictício.

`MeliClient.loadOrderInput(id)` lê `/orders/:id` e, quando referenciados,
`/shipments/:id` com `x-format-new: true` e
`/orders/billing-info/MLB/:id`. O perfil do comprador não é buscado
automaticamente. Nenhuma dessas operações deve ocorrer dentro de transação SQL.

GET tem até três tentativas, timeout por tentativa e backoff com jitter para
rede/429/5xx. `Retry-After` até cinco segundos é respeitado; esperas maiores
encerram a chamada sem antecipar uma retentativa. Um 401 permite uma renovação e
uma nova leitura. Refresh concorrente no mesmo cliente é compartilhado.
POST OAuth não é repetido automaticamente: códigos são de uso único e refresh
tokens rotacionam. Erros públicos contêm código/status e mensagem estática,
sem corpo externo, credenciais ou causa de transporte.

## Autorizar a aplicação local

O MCP consulta documentação e tem autorização separada da aplicação Omnihub.
Na TASK-004, OAuth e smoke passaram a usar o Hub na porta 3000, com state,
PKCE S256, expiração e armazenamento privado compartilhado. Não há segundo
listener no fluxo normal. Preparação, tokens administrativos locais, criação
explícita de contas e endpoints em [guia do pipeline](../../docs/integrations/task-004.md).

```powershell
bun run setup:local
bun run dev:api
# Em outro terminal, com o Hub ativo:
bun run meli:authorize
bun run meli:smoke
# Opcional, somente pedido do vendedor de teste configurado:
bun run meli:smoke --order-id ID_DO_PEDIDO_DE_TESTE
```

Redirect exato cadastrado, terminado em /api/oauth/meli/callback, encaminhado
pelo túnel HTTPS para localhost:3000. Quando o domínio público mudar, atualizar
.env e cadastro no DevCenter. O comando histórico `authorize-standalone`
permanece disponível, mas só pode ocupar a porta configurada com a API parada.
MELI_OAUTH_LISTEN_PORT afeta apenas essa alternativa; o Hub usa HUB_PORT.

Tokens do vendedor ficam em output/meli/tokens.json. O Hub é o único escritor
no fluxo normal, inclusive no smoke. Usa gravação temporária + rename e modo
0600 onde suportado; no Windows, depende também da ACL da pasta. É armazenamento
local de um processo/aplicação, sem homologação multiusuário/multiprocesso.
Não copiar output/meli para Git, cofre ou evidências compartilhadas. Se o processo
cair após rotação remota e antes da persistência, pode ser necessário reautorizar.

O smoke exige identidade esperada, MLB e test_user; registra flags, data e padrões
de operações em output/task-004/meli-smoke-*.json, sem IDs/PII/tokens. Leitura
opcional de pedido não implica normalização: canonicalParsingVerified permanece
false. A identidade oficial do vendedor de teste foi verificada nesta entrega;
leitura de pedido/publicação de saldo oficiais continuam sem ensaio identificado.

O utilitário `bun run meli:create-test-users` cria/reutiliza vendedor e comprador
por POST explícito, sem retry automático, após autorização inicial da conta
criadora. Credenciais em output/meli/test-users.json e tokens iniciais em
bootstrap-tokens.json, ambos privados. Depois é necessário entrar e autorizar
com o vendedor criado. A API usa contas de teste na produção oficial, sem
sandbox separado; não fazer transações de teste com contas reais.

## Emissão e testes

O pacote também fornece o emissor IR → ERP legado, atualização absoluta de saldo
Mercado Livre (com verificação de vendedor de teste e dono do anúncio), inspeção
mascarada de snapshots e HMAC do callback interno ERP. Essas funções não acessam
PostgreSQL. Cancelamento é identificado no recurso autorizado para permitir ao
Hub liberar uma reserva existente sem reconstruir PII ocultada.

```powershell
bun test packages/marketplace-adapters/tests
bun run typecheck
bun test
```

Os testes do pacote usam transporte injetado e dados sintéticos. As origens dos
contratos constam no [catálogo de fixtures](tests/fixtures/README.md); a primeira
entrega tem [snapshot histórico](../../docs/integrations/task-003.md). O guia da
TASK-004 diferencia OAuth/identidade oficiais dos ensaios locais do pipeline.
