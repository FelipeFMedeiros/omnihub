# TASK-014 — Conexões de lojas e ERP por negócio

Backend sobre a TASK-013 (`19aea1f78992ed972f4c87a67542a327943743b3`).
A tarefa permanece **in-progress**, aguardando QA e aceite do coordenador.
Contrato gerado dos handlers: [OpenAPI](task-014.openapi.json).
A interface pertence à TASK-006; não há tela nova nesta entrega.

## Contratos de navegador

As rotas abaixo usam sessão HttpOnly revogável. Workspace vem da sessão no
servidor; objetos estrangeiros retornam 404. Bearer de operador não é aceito
nessas rotas. Mutações exigem Origin permitido, X-CSRF-Token e X-Turnstile-Token
novo, action `domain_mutation`, cdata da sessão. Polling GET não chama siteverify.
Schemas rejeitam propriedades extras, incluindo workspaceId, URL, segredo e
payload arbitrário. Erros têm `{error:{code,message}}`.

| Método e rota | Entrada / resultado |
| --- | --- |
| GET `/api/v1/connections` | `{data:[id,name,platform,transportMode,state,status,createdAt,checkedAt,checkStatus,latencyMs]}` |
| POST `/api/v1/connections` | `{name,platform,transportMode}`; 201 com metadados seguros |
| POST `/api/v1/connections/:id/oauth/start` | `{attemptId,authorizationUrl,expiresAt}` |
| POST `/api/v1/connections/:id/reconnect` | pausa credenciais antigas e inicia nova tentativa |
| GET `/api/v1/connections/:id/oauth` | tentativa da sessão iniciadora: STARTED/EXCHANGING/PENDING/CONFIRMED/FAILED/EXPIRED ou null |
| POST `/api/v1/connections/:id/oauth/confirm` | `{attemptId}`; ativa resultado privado da sessão iniciadora |
| POST `/api/v1/connections/:id/disable` | remove credenciais/tentativas pendentes; conserva identidade/histórico |
| POST `/api/v1/connections/:id/check` | mede identidade/transporte; retorna metadados e horário |
| POST `/api/v1/connections/:id/simulate` | `{scenario:"PAID"\|"INVALID_TOTAL"}`; `{accepted,processingId,origin,scenario}` |
| GET `/api/v1/erp-destinations` | destinos permitidos, sem URL/segredos |
| POST `/api/v1/erp-destinations/select` | `{destinationId}`; um destino ativo por negócio |

Plataformas: MERCADO_LIVRE, AMAZON, SHOPEE. Modos: OFFICIAL_TEST_USER e
LOCAL_FIXTURE. Amazon/Shopee aceitam somente metadados desabilitados; ações
executáveis retornam 501 NOT_IMPLEMENTED. Mercado Livre oficial exige
MLB/test_user. Loja local tem identidade sintética própria, sem tokens oficiais.
Criar conexão não importa catálogo, mapeamentos ou estoque.

`state` mantém ACTIVE/DISABLED da TASK-013. `status` distingue NOT_CONNECTED,
CONNECTED, REAUTH_REQUIRED, DISABLED, ERROR e NOT_IMPLEMENTED. CONNECTED indica
credencial/identidade vinculada; disponibilidade é medida em `checkStatus` e
`checkedAt`. Ausência de medição é null; sucesso antigo não garante o presente.
Não se expõem identidade externa, tokens, JWT, senha/hash ou chave. Medições de
lojas persistem por workspace/conexão; disable/reconnect invalidam a medição.
ERP conserva `/api/v1/dashboard/connections/check` e cache volátil por workspace/
destino. Destino desabilitado nunca herda indicador disponível.

## Callback entre hosts

Redirect cadastrado preservado exatamente:
`https://remainder-mesa-wise-teach.trycloudflare.com/api/oauth/meli/callback`.
O Hub real desse túnel deve usar localhost:3000. Não alterar túnel/DevCenter.
Runtime não abre listeners extras. Notificações continuam em `/api/webhooks/meli`.

State CSPRNG de 256 bits, PKCE S256 obrigatório e prazo de dez minutos. PostgreSQL
guarda digest do state, contexto usuário/sessão/workspace/conexão, geração e
envelope privado. Nova tentativa invalida a anterior. Callback público não exige
cookie: reivindica state uma vez, troca código sem retry e consulta `/users/me`
pelo adaptador. Resultado fica PENDING criptografado; callback não ativa loja.

Retorno 303 usa exclusivamente `/connections` na PUBLIC_DASHBOARD_URL do servidor,
sem code/state/token/ID na URL. UI consulta e confirma com a **mesma sessão ativa**.
Outro login, mesmo do mesmo usuário, não confirma. Logout/expiração, replay,
tentativa vencida ou geração invalidada impedem ativação. Confirmação bloqueia a
sessão contra logout. Identidade existente nunca muda; índice único resolve
claims concorrentes da mesma conta entre negócios. Disable não libera identidade.

São aceitos a origem HTTPS cadastrada e o upstream local configurado. Quando o
Hub usa HTTP loopback, também o **Host público fixo** do redirect preservado pelo
cloudflared é aceito no upstream HTTP. Não se confia em headers forwarded. A
troca/validação utiliza o redirect HTTPS exato. SameSite=Lax, Secure determinado
pela URL pública, Origin e CSRF não foram relaxados. Respostas usam no-store e
no-referrer. O aplicativo não registra URL de callback; infraestrutura externa
deve omitir query OAuth de seus logs.

OAuth administrativo histórico `/api/oauth/meli/start` e `/smoke` não ativa lojas.
Runtime padrão não inicializa OAuth global nem lê arquivo global de tokens.

## Criptografia e refresh

Opt-in: CONNECTIONS_ENABLED=true. CONNECTION_KEYS_FILE aponta para JSON privado
fora do banco, Git e preferencialmente da worktree. Formato com placeholders:

```json
{"activeVersion":"v1","keys":{"v1":"BASE64_DE_32_BYTES_ALEATORIOS"}}
```

Gerar com CSPRNG, proteger ACL no Windows e manter backup seguro. App ID/secret
continuam no servidor. AES-256-GCM por conexão, nonce novo de 96 bits, tag de 128
bits, versão e AAD com formato/versão/workspace/conexão/app/finalidade impedem
troca de envelopes. Tokens e tentativas têm finalidades distintas. Sem chave ou
com envelope adulterado, operação falha; não há fallback plaintext.

Rotação de chave: adicionar v2, mudar activeVersion e reiniciar, conservando v1
enquanto existirem envelopes antigos. Novas gravações usam v2. Remover chave
necessária exige restauração administrativa ou reautorização. Nunca imprimir
chaves, `.env`, tokens ou callbacks nas evidências.

Cada operação oficial adquire lease persistente de dois minutos por conexão.
Instâncias do store compartilham a serialização. HTTP fica fora de transações.
Antes de consumir refresh, persiste ROTATING; tokens novos são gravados com
comparação de revisão/lease antes do uso. POST de código/refresh não tem retry.
Falha ambígua/persistência exige REAUTH_REQUIRED. ROTATING abandonado após crash
também exige reautorização, sem consumir refresh antigo. Lease READY abandonada
pode ser recuperada. Espera local de disputa: até cinco segundos, depois
CONNECTION_BUSY. Clientes/tokens/locks não são compartilhados entre lojas.

## Importação explícita

Runtime não lê tokens.json, bootstrap-tokens.json ou MELI_REFRESH_TOKEN.
Importar exige proprietário/conta verificados por meio independente e escritor
anterior parado/fenceado. O importador não rotaciona a origem: exige token fresco,
app/conta esperadas e `/users/me` MLB/test_user. Alvo deve ser conexão **nova**,
desabilitada, do proprietário verificado em workspace ACCOUNT. Recusa bootstrap
inclusive pelo caminho real, alvo estrangeiro, reimportação, conta duplicada e
token expirado. Não reivindica legado. Auditoria registra digest/comprovação.

```powershell
bun run connections:import --workspace UUID_NEGOCIO --connection UUID_CONEXAO --verified-owner UUID_PROPRIETARIO --expected-account ID_TESTE_VERIFICADO --source CAMINHO_PRIVADO/tokens.json --verification-reference REFERENCIA_VERIFICADA --report output/task-014/identity-import.json --confirm-import
```

Relatório contém apenas flags/modo/operações/data. Não usar refresh em dois
custódios. Smoke legado exige um único escritor que persista a rotação
atomicamente na origem antes de importar. Cópia de teste não permanece ativa
para refresh ao devolver a custódia ao legado. Chave/store/configuração do
custódio devem sobreviver ao cleanup da worktree.

## Desabilitação e corridas

Disable incrementa geração, apaga credenciais e invalida OAuth pendente. Novos
jobs/retry/publicações/leituras oficiais ficam bloqueados. Enqueue, claim e
reserva usam locks compartilhados de conexão na transação, ordenados contra
disable. Gateway confere geração/lease antes de cada nova chamada. Uma chamada
já iniciada pode terminar após disable; não há cancelamento externo implícito.

Se disable vence antes da reserva, ingestão falha sem pedido/SALE. Reserva
comitada permanece. Despacho iniciado continua com destino/chave originais e
orçamento de três tentativas, podendo finalizar mesmo com loja desabilitada.
FULFILLMENT reduz físico/reservado juntos, delta zero, sem repetir SALE.
Falha/exaustão conserva reserva para conciliação. Não apagar histórico, cancelar
venda ou liberar estoque implicitamente. Reconectar exige a mesma conta e não
retoma jobs falhos nem reinicia orçamento automaticamente.

## ERP e simulação

ERP é pré-cadastrado pelo operador em erp_destinations e permitido no arquivo
privado ERP_TARGETS_FILE da TASK-013. Pode estar DISABLED para seleção. Workspace,
ID, configKey e origem loopback devem coincidir. Endpoints e segredos HMAC são
exclusivos; armazém/recibos ficam em instâncias/transportes dedicados por negócio.
UI envia só ID. Troca de ERP bloqueada com jobs QUEUED/PROCESSING/FAILED ou
despacho não confirmado/faturamento pendente, exigindo conciliação administrativa. Seleção não move
jobs nem altera payload/chave/destino/orçamento de despacho iniciado. HMAC bruto
por destino e contrato Mock ERP permanecem. ERP próprio exige MOCK_ERP_V1 ou
adaptador explícito futuro; não há integração universal.

Simulação aceita apenas LOCAL_FIXTURE/MERCADO_LIVRE com fixture versionada
`meli-order-legacy.json`. Cenários PAID/INVALID_TOTAL têm origem
LOCAL_FIXTURE_TASK014_V1 na resposta/snapshot bruto. Gateway local reconstrói o
recurso pela referência durável e executa parser, IR, reserva, SALE e Mock ERP
reais. Publicação local usa espelho em memória; não comprova PUT oficial. Mapear
MLB1234567890 a SKU do negócio antes de simular PAID. Sem mapping/destino, retorna
falha real; não injeta IR pronta. Webhook M2M gerenciado recusa fixtures locais,
resolve uma conexão oficial ativa por app/identidade/recurso no adaptador e
consulta o recurso autorizado antes da reserva. Tenant do payload não autoriza
propriedade. Não existe HMAC Mercado Livre fabricado.

## Reprodução e evidências

Bancos exclusivos: omnihub_task014_dev e omnihub_task014_test_db. Nenhum banco
compartilhado, container/volume ou legado real foi migrado/reivindicado.
Migration 0008 adiciona metadados/credenciais/tentativas/importações. Ensaio
0007 → 0008 compara todas as colunas históricas de dados representativos.

```powershell
bun install
bun --env-file=.env packages/database/scripts/verify-task014-upgrade.ts --reset-task014-test
bun run db:generate
bun run db:migrate
bun run db:seed
bun run db:seed
bun run typecheck
bun test
bun run api:openapi
git diff --check
```

Reset valida nome exato do banco de teste e exige flag antes de DROP. Testes
normais removem somente UUIDs criados. `bun test` puro deve passar com artefatos
presentes; bunfig exclui somente output/**. Fonte, arquivos novos, hashes e
tentativas falhas ficam no handoff. Não há lint. Não houve benchmark/k6 ou
homologação produtiva. Resultados oficiais/local/não executado são separados no
output/task-014 e log datado do cofre. UI, ARIMA, Amazon/Shopee executáveis e
novos ERPs permanecem fora do escopo.

## Fontes oficiais consultadas em 2026-11-13

- [OAuth e refresh](https://developers.mercadolivre.com.br/pt_br/autenticacao-e-autorizacao),
  MCP oficial, página atualizada em 2025-12-29T16:02:39Z: redirect exato,
  state/PKCE S256, grant por formulário, duração anunciada de seis horas e refresh
  de uso único. Cliente respeita expires_in retornado. Grant existente não é
  presumido válido.
- [Recomendações de token](https://developers.mercadolivre.com.br/pt_br/desenvolvimento-seguro),
  MCP oficial, atualização 2025-12-30T14:14:43Z: parâmetros sensíveis no corpo,
  access token em Authorization, correspondência entre usuário e recurso.
- [Notificações](https://developers.mercadolivre.com.br/pt_br/produto-receba-notificacoes)
  e [testes](https://developers.mercadolivre.com.br/pt_br/realizacao-de-testes):
  contratos já registrados nas TASK-003/004; nenhuma operação oficial ampliada.

Dez minutos, leases, espera e três tentativas GET/ERP são limites do projeto,
sem promessa de SLA ou quota universal da API Mercado Livre.

## Smoke oficial desta entrega

Em 2026-11-13, às 07:44:17 UTC, `/users/me` confirmou conta esperada, MLB e
test_user. Um único POST de refresh foi executado pelo custódio legado na janela
reservada pelo coordenador, com persistência atômica no arquivo privado principal
antes do uso. O importador explícito e o gateway por conexão repetiram somente a
leitura de identidade em omnihub_task014_dev, cujo nome real foi conferido antes
do consumo. Após leitura, a conexão temporária ficou DISABLED e sua credencial
foi apagada; o lock foi liberado. O arquivo principal foi relido, confirmando
app/conta esperadas e access fresco, sem imprimir valores.

`output/task-014/official-identity-smoke.json` e
`official-custody-verification.json` guardam apenas flags, horários e operações.
O arquivo privado principal continua custódio recuperável. Chaves e configuração
privadas estão fora da worktree. Não se executou outro refresh no store de teste.
Nenhum listener foi iniciado, nem pedido/anúncio/PUT de estoque oficial. OAuth
novo pelo túnel e UI continuam sem ensaio público nesta rodada; callback/confirm
entre hosts foram validados com transporte injetado e handlers reais.
