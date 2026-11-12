# TASK-003 — Primeira entrega do adaptador

Implementada em `develop`, em 2026-11-12. Base: `SpokeAdapter`, schemas TypeBox,
parser Mercado Livre determinístico, consulta/enriquecimento de leitura e helper
OAuth com state, redirect, PKCE, expiração e refresh rotacionado.

O [guia do pacote](../../packages/marketplace-adapters/README.md) descreve a API,
comandos e limites. A [origem das fixtures](../../packages/marketplace-adapters/tests/fixtures/README.md)
distingue contratos oficiais consultados pelo MCP de dados inteiramente sintéticos.

## Verificações de engenharia da entrega inicial

| Verificação | Resultado |
| --- | --- |
| MCP Mercado Livre | OAuth ativo; duas ferramentas de documentação responderam |
| `bun run typecheck` | Todos os workspaces passaram |
| `bun test`, com PostgreSQL temporário isolado 17.10 | 152 aprovados, 0 falhos, 0 ignorados; 9 arquivos |
| Novos casos no pacote de adaptadores | 70 casos, todos incluídos na execução acima; transporte simulado |
| Primeira tentativa com o `.env` existente | 113 aprovados e 3 falhas de preparação de suítes por autenticação PostgreSQL (`28P01`); não foi defeito do parser |
| OAuth da aplicação e smoke na API oficial | **Pendente**; autor preparando `.env` e avisará quando estiver pronto |

O banco da execução aprovada foi `omnihub_task003_verify`, em contêiner próprio
`postgres:17-alpine`, porta aleatória de loopback e credencial efêmera.
`TEST_DATABASE_URL` foi sobrescrita somente no processo de testes; o `.env` e o
banco do autor foram preservados. A suíte aplicou as migrations existentes nesse
banco; não houve alteração de schema/migration. O contêiner foi removido ao final.

Após organizar o ambiente local, a suíte completa foi novamente aprovada no
`TEST_DATABASE_URL` isolado do projeto: 152 testes, sem falhas, e typecheck
aprovado. O PostgreSQL local publica a porta 55432. Redirect/túnel foram
configurados depois; OAuth da aplicação e smoke externo continuam pendentes.

Os testes cobrem normalização, dados incompletos, mapeamento de variações,
precisão monetária/IDs, divergência de recursos, callbacks inválidos, rotação e
persistência de tokens, concorrência de refresh, timeout, backoff e bloqueio de
leitura de pedido quando a identidade não é de teste. Não foi executado lint,
k6, estudo de usabilidade ou benchmark de desempenho. As verificações da UI
continuam pertencendo à entrega TASK-009.

## Evidências preservadas

O cofre mantém o log
`C:/vault-agents/projects/ominihub/logs/2026-11-12-task-003-mercado-livre.md`
e a pasta `logs/evidences/task-003-2026-11-12/`, com:

- `bun-test-isolated.txt`, `typecheck.txt` e relatório sanitizado de execução;
- `primeiro-adaptador.zip`: overlay dos fontes do pacote e contratos canônicos,
  configurações estritas, manifestos e lockfile sobre o HEAD identificado;
- `snapshot-manifest.json`: revisão Git, branch, estado local e SHA-256 de cada
  fonte incluído no overlay, além do hash do ZIP.

Os arquivos originais de verificação também ficam em `output/task-003/`,
ignorado pelo Git. `output/meli` e qualquer `.env` real **não** fazem parte
do snapshot. Essa referência preserva o fonte local testado antes do primeiro
commit da TASK-003; o HEAD registrado naquele manifesto identifica apenas sua
base. O histórico Git passa a identificar a entrega versionada e seus ajustes.

## Interpretação para o TCC

O resultado sustenta conformidade local do primeiro parser com a IR e os
comportamentos de falha/credenciais nos cenários testados. Não comprova ainda
integração autenticada da aplicação, ingestão de notificações, despacho ERP,
normalização de pedidos reais, desempenho produtivo ou escalabilidade multicanal.

O formato moderno pode omitir e-mail e outros dados obrigatórios da IR. A decisão
atual é rejeitar informação insuficiente e preservar o contrato canônico; a
TASK-004 deve definir o caso autorizado de ponta a ponta e, se necessário,
revisar explicitamente a IR. Frete/descontos incompatíveis também são rejeitados.
Os detalhes do canal ficam no adaptador; hub, banco e IR não precisaram mudar.
A comparação antes/depois da Shopee continua planejada na TASK-012.
