# Contratos e fixtures Mercado Livre

Coleta de documentação pelo MCP `mercadolibre-mcp-server` em **2026-11-12**.
São projeções de leitura, não uma cópia integral do schema externo. A API pode
acrescentar campos; somente os campos usados precisam satisfazer os schemas.

| Fonte oficial | `lastUpdated` informado pelo MCP | Uso |
| --- | --- | --- |
| [Gerenciamento de vendas](https://developers.mercadolivre.com.br/pt_br/gerenciamento-de-vendas) | 2026-09-21 | Pedido, itens, IDs e referência de entrega |
| [Pedidos e opiniões](https://developers.mercadolivre.com.br/pt_br/pedidos-e-opinioes) | 2026-08-11 | Formato legado com dados embutidos |
| [Gerenciamento de envios](https://developers.mercadolivre.com.br/pt_br/gerenciamento-de-envios) | 2026-09-18 | `destination.shipping_address`, formato novo |
| [Faturamento](https://developers.mercadolivre.com.br/pt_br/faturamento) | 2026-06-16 | `/orders/billing-info/MLB/:id`, CPF/CNPJ |
| [Notificações](https://developers.mercadolivre.com.br/pt_br/produto-receba-notificacoes) | 2026-11-03 | Aviso `orders_v2` e consulta posterior |
| [Autenticação e autorização](https://developers.mercadolivre.com.br/pt_br/autenticacao-e-autorizacao) | 2025-12-29 | OAuth code, redirect, PKCE e refresh |
| [Consulta de usuários](https://developers.mercadolivre.com.br/pt_br/consulta-de-usuarios) | 2025-12-30 | Projeção de identidade e perfil quando autorizado |

`lastUpdated` é metadado da página, **não** uma versão semântica garantida da API.
Também foi consultada a [orientação de testes](https://developers.mercadolivre.com.br/pt_br/realizacao-de-testes):
usuários de teste usam endpoints oficiais no ambiente de produção. O protocolo
dessas páginas foi conferido nesta entrega; nenhuma fixture é captura de uma
resposta da conta do autor.

- `meli-order-legacy.json`: pedido sintético com dados embutidos. Serve para
  normalização e compatibilidade local; não pressupõe que a API atual devolva
  esses dados pessoais a toda aplicação.
- `meli-order-enriched.json`: pedido moderno + entrega + faturamento + perfil
  suplementar autorizado **simulado**. O e-mail é uma precondição deste caso,
  não um dado garantido pela API. O teste sem perfil demonstra a rejeição.

IDs, documentos, endereço, nome, telefone e preços foram inventados para teste;
e-mail usa o domínio reservado `example.invalid`. Nenhuma conta foi criada com
esses valores, e eles não são credenciais utilizáveis. Os documentos exercitam
formato e comprimento, sem alegação de validade fiscal.

No exemplo: `19.99 × 2 = 39.98` vira `1999 × 2 = 3998` centavos,
`123.456.789-01` vira `12345678901`, `01001-000` vira `01001000` e `BR-SP`
vira `SP`. `MLB1234567890:12345` é resolvido para `SKU-VARIACAO` por contexto
explícito, preservando o núcleo independente do canal.
