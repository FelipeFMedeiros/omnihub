# Adaptadores do Omnihub — TASK-003

Esta entrega contém a interface `SpokeAdapter`, schemas de leitura e o primeiro
parser Mercado Livre → `CanonicalOrder`. O cliente HTTP e o helper OAuth são
independentes do MCP. Amazon e Shopee pertencem às TASK-011/012; ingestão HTTP,
estoque e despacho ERP serão conectados na TASK-004.

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

O MCP autenticado serve para consultar documentação; sua autorização não é a do
aplicativo Omnihub. O Mercado Livre usa **usuários de teste no ambiente de
produção**, sem sandbox separado. Use o fluxo oficial de usuários de teste e
somente transações entre essas contas. Estes comandos não criam contas ou pedidos.

1. Preencha somente as chaves ausentes no `.env` da raiz, sem sobrescrevê-lo:
   `MELI_APP_ID`, `MELI_CLIENT_SECRET`, `MELI_REDIRECT_URI` e
   `MELI_TEST_SELLER_ID`. O redirect deve ser exatamente o cadastrado no DevCenter.
2. `MELI_USE_PKCE=true` é o padrão; alinhe com a configuração PKCE da aplicação.
   O helper usa state aleatório, prazo de dez minutos e S256 quando habilitado.
3. Para redirect HTTPS público, configure o encaminhamento dessa rota para
   `http://127.0.0.1:3001` antes da autorização. A porta local pode ser alterada por
   `MELI_OAUTH_LISTEN_PORT`. O helper não instala nem inicia túnel.
   HTTP de loopback só funciona se a plataforma aceitar esse cadastro.
4. Execute na raiz e abra a URL apresentada, autorizando com o vendedor de teste:

```powershell
bun run meli:authorize
```

O callback confere state, expiração, caminho e parâmetros fixos do redirect.
Client secret e code verifier não aparecem na URL de autorização. O resultado
fica em `output/meli/tokens.json`, ignorado pelo Git. O helper persiste a rotação
antes de usar os tokens e prefere esse arquivo ao refresh inicial do `.env`.
Alternativamente, um `MELI_REFRESH_TOKEN` obtido pelo fluxo oficial pode iniciar
o primeiro refresh. Não reutilize um refresh antigo após a rotação.

Esse arquivo é um armazenamento privado de **desenvolvimento local, para um
processo/aplicação**. Usa gravação temporária e rename; modo `0600` quando
suportado pelo sistema. No Windows, as permissões dependem da ACL da pasta.
Não sincronize `output/meli` para o cofre, Git ou evidências públicas.
Armazenamento multiusuário e disputa de refresh entre processos não estão nesta
entrega. Se o processo cair após o servidor rotacionar o token, pode ser
necessário autorizar novamente.

## Smoke oficial explícito de leitura

Configuração local informada em 2026-11-12: túnel HTTPS encaminhado para
`localhost:3000`, com callback `/api/oauth/meli/callback` e notificações
`/api/webhooks/meli`. O `.env` local usa `MELI_OAUTH_LISTEN_PORT=3000` para o
helper standalone. Nesse modo, pare `dev:api` antes de executar `meli:authorize`;
dois processos não podem ocupar a mesma porta. A TASK-004 integrará essas rotas
ao Hub na 3000; a API atual ainda não as oferece. O valor padrão do helper
continua 3001 para outros encaminhamentos. Se o domínio público mudar, atualize
o redirect no `.env` e no DevCenter.

```powershell
bun run meli:smoke
# Opcional, somente pedido do vendedor de teste configurado:
bun run meli:smoke --order-id ID_DO_PEDIDO_DE_TESTE
```

O smoke primeiro consulta `/users/me` e exige `MLB`, tag `test_user` e o vendedor
esperado. Só então permite ler um pedido e seus recursos. A saída e o relatório
em `output/task-003/meli-smoke-*.json` contêm apenas flags, data, modo e padrões
de operações; não contêm IDs, PII ou tokens. A opção de pedido confirma leitura,
não promete conformidade integral com a IR. `canonicalParsingVerified: false`
explicita esse limite. `MELI_TEST_BUYER_ID` documenta a futura conta compradora e
ainda não é consumido pelo helper.

```powershell
bun test packages/marketplace-adapters/tests
bun run typecheck
bun test
```

Os testes desse pacote usam transporte injetado e dados sintéticos; não fazem
chamadas externas e não precisam de `.env`. Origem/versão dos contratos estão no
[catálogo de fixtures](tests/fixtures/README.md). A primeira entrega possui
[registro de evidências e snapshot](../../docs/integrations/task-003.md).
