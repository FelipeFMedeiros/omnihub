# TASK-005 — Conta central e proteção de borda

Evolução TASK-013: [domínio isolado por negócio/conexão](task-013.md) libera a
sessão para seu próprio workspace. As restrições globais descritas abaixo são o
contrato histórico da TASK-005; cadastro sem herança, sessão, CSRF e Turnstile
permanecem preservados. A tarefa de isolamento aguarda QA independente.

O backend oferece cadastro, login e sessão de conta. Cada cadastro cria usuário,
workspace vazio e sessão na mesma transação. Nenhum cadastro recebe o estoque,
pedidos, mapeamentos ou credenciais globais da TASK-004. O domínio continua
exclusivo do operador local até a TASK-013; conexões por conta são da TASK-014
e os formulários/dashboard são da TASK-006.

## Configurar e executar

Na raiz, instale com `bun install`, prepare `.env` a partir de `.env.example`
sem substituir um arquivo existente e execute `bun run setup:local`.
Esse comando agora também gera `JWT_SECRET` privado, sem imprimir valores.
Execute `bun run db:migrate` somente no banco de desenvolvimento pretendido.
A migration `0004_messy_joshua_kane.sql` adiciona `users`, `workspaces` e
`auth_sessions`, sem atribuir dados legados a usuários.

| Variável | Contrato |
| --- | --- |
| `JWT_SECRET` | Segredo aleatório privado, mínimo 32 bytes; rotação invalida cookies existentes |
| `PUBLIC_HUB_URL` | Origem canônica do Hub; também é `iss`. HTTPS obrigatório, HTTP apenas loopback fora de produção |
| `AUTH_SESSION_TTL_SECONDS` | 60–3600; padrão 3600, sem refresh automático |
| `CORS_ORIGINS` | Lista de origens exatas separadas por vírgula; HTTPS em produção, sem wildcard |
| `CLOUDFLARE_TURNSTILE_SECRET_KEY` | Secret somente backend; obrigatório ao iniciar API |
| `TURNSTILE_TIMEOUT_MS` | 100–10000, padrão 5000; falha/timeout bloqueia a ação |
| `TRUSTED_PROXY_IPS` | Vazio por padrão; lista de IPs exatos de proxies com ingresso protegido |
| `TRUSTED_PROXY_HEADER` | `cf-connecting-ip` (padrão) ou `x-forwarded-for` |
| `HUB_ADMIN_TOKEN` | Credencial somente CLI do operador; nunca usar no bundle, formulário ou Scalar |

`VITE_TURNSTILE_SITE_KEY=1x00000000000000000000AA` é a **sitekey pública** para
o widget da TASK-006. O secret dummy backend autorizado é
`1x0000000000000000000000000000000AA`. Não são intercambiáveis. Chaves dummy
são recusadas em produção, mesmo com HTTPS. Não existe bypass de siteverify.
O endpoint de verificação é fixo no host oficial; override arbitrário é recusado.

## Contrato HTTP para TASK-006

Todas as respostas de conta usam `Cache-Control: no-store` e
`Referrer-Policy: no-referrer`. Erros: `{ "error": { "code": "...", "message": "..." } }`.
Schemas de sucesso/erro estão em `/docs/json`.

| Método/rota | Entrada e resultado |
| --- | --- |
| `POST /api/auth/register` | JSON `{name,email,password,turnstileToken}` + `Origin`; 201 e cookie de sessão |
| `POST /api/auth/login` | JSON `{email,password,turnstileToken}` + `Origin`; 200 e novo cookie |
| `GET /api/auth/session` | Cookie; 200 com conta/workspace, expiração e CSRF; nenhuma chamada Turnstile |
| `POST /api/auth/logout` | Cookie + `Origin` + `X-CSRF-Token`; 204 sem corpo, revoga sessão e limpa cookie |

Nome: 1–120 caracteres após trim/NFC. E-mail: trim/lowercase, formato validado,
máximo 254, único também no banco. Senha do cadastro: 12–128 caracteres; login
aceita 1–128 para responder credenciais inválidas. Hash Argon2id com 65536 KiB,
3 iterações e salt aleatório pelo Bun. Não há senha/hash/JWT no JSON de resposta.

Cadastro/login/session devolvem exclusivamente:

```json
{
  "user": { "id": "UUID", "name": "Nome", "email": "email@example.invalid" },
  "workspace": { "id": "UUID", "name": "Meu negócio" },
  "expiresAt": "2026-11-12T23:00:00.000Z",
  "csrfToken": "TOKEN_OPACO_VINCULADO_A_ESTA_SESSAO"
}
```

O cookie `omnihub_session` é HttpOnly, SameSite=Lax, Path=/, sem Domain e tem
Max-Age igual ao TTL. `Secure` é determinado pela origem canônica configurada,
inclusive se o túnel terminar HTTPS e encaminhar HTTP local. Headers encaminhados
não relaxam essa política. O JWT HS256 valida `sub`, `sid`, `iss`, `aud`, `iat`,
`exp`, algoritmo/tipo, prazo e vínculo exato à sessão persistida não revogada.
O workspace é resolvido pela propriedade no servidor; IDs fornecidos pelo cliente
não selecionam outro contexto.

O cliente usa `credentials: 'include'`, mantém somente o CSRF em memória e envia
`X-CSRF-Token` nas mutações por cookie. Recupera o CSRF em `GET /session` ao
recarregar. Não guardar o JWT em localStorage/sessionStorage. Login/cadastro
exigem `Origin` permitido mesmo sem sessão e mídia `application/json`.
Logout não exige Turnstile, mas exige Origin e CSRF. Após 401, descartar o estado
local e abrir login; o servidor também limpa cookie inválido/expirado.

| HTTP/código | Tratamento do cliente |
| --- | --- |
| 401 `UNAUTHENTICATED` | Sessão ausente, expirada, revogada ou inválida; autenticar novamente |
| 401 `INVALID_CREDENTIALS` | Mesmo erro para senha incorreta e conta inexistente |
| 403 `TURNSTILE_CHALLENGE_FAILED` | Obter desafio novo, inclusive após timeout/rejeição/expiração/reuso |
| 403 `ORIGIN_NOT_ALLOWED` / `CSRF_INVALID` | Corrigir origem/configuração ou recuperar CSRF; não repetir mutação sem correção |
| 403 `AUTH_HTTPS_REQUIRED` | Acesso incompatível com a política de transporte |
| 403 `OPERATOR_BROWSER_FORBIDDEN` | Rotas globais não estão disponíveis ao navegador nesta etapa |
| 409 `ACCOUNT_ALREADY_EXISTS` | Cadastro não realizado com esse e-mail |
| 415 `JSON_REQUIRED`, 422 `VALIDATION_ERROR` / `INVALID_EMAIL` / `INVALID_REGISTRATION` | Corrigir campos/mídia |
| 429 `RATE_LIMITED` | Respeitar `Retry-After` em segundos |
| 503 `AUTH_NOT_CONFIGURED` / `LOCAL_ADMIN_NOT_CONFIGURED` | Configuração do servidor indisponível |

## Turnstile e ações futuras

Cadastro usa action `register`, login usa `login`. Fora do modo dummy, o backend
confere hostname entre os hosts das origens permitidas, action e desafio de até
300 segundos. A proteção reutilizável `requireSensitiveAction` exige sessão,
Origin, CSRF e novo desafio com action específica e cdata igual ao `csrfToken`
da sessão. É contrato para futuras conexões/simulação; nenhuma dessas rotas foi
aberta sobre as tabelas globais.

No modo real, digests SHA-256 dos tokens são reivindicados antes do HTTP por
300 segundos, impedindo reuso próximo/concorrente no processo da PoC enquanto
a detecção de reuso do siteverify converge. Não se armazenam tokens brutos.
O cache é limitado a 10000 entradas e falha fechado quando cheio; reinício o
limpa. Múltiplas réplicas exigiriam armazenamento compartilhado, fora desta PoC.
No dummy, o token estático de teste pode repetir: cada tentativa ainda faz
siteverify. Essa exceção depende da chave oficial de teste fora de produção.

```powershell
bun run auth:turnstile-smoke
```

O smoke usa apenas a chave pública dummy autorizada, faz duas chamadas reais e
grava `output/task-005/siteverify-smoke.json` sem tokens/segredos. A resposta dummy
é `hostname: example.com`, sem action/cdata; o always-pass pode aprovar o mesmo
token duas vezes. Os testes injetados verificam rejeição, timeout, expiração,
reuso e regras reais separadamente. O smoke não mede eficácia antibot.

## Domínio global, M2M e túnel

Todas as rotas `/api/v1/*`, inclusive estoque/ledger e consultas do inspetor,
e OAuth administrativo (start/smoke) exigem `Authorization: Bearer` do operador.
São recusadas quando há `Origin` ou `Sec-Fetch-Site`, mesmo com token válido.
Não enviar essa credencial ao navegador. O callback Mercado Livre continua
público com state/PKCE da TASK-004; não cria vínculo com conta central.

Webhooks não exigem cookie, Origin, CSRF nem Turnstile. ERP conserva HMAC sobre
corpo bruto antes de interpretar JSON. Mercado Livre conserva validação de
app/vendedor/caminho, fila durável e consulta OAuth autenticada antes do parser;
não recebeu assinatura HMAC fictícia. Reserva/idempotência/retries permanecem
nos serviços transacionais da TASK-004.

Autenticação (login/cadastro juntos) admite 10 requisições/minuto por IP do peer;
ingestão de webhooks, 500/s por peer. Janela fixa em memória por processo; não
é garantia de throughput nem limitador distribuído. Polling da sessão não usa
o orçamento de tentativas de login. Barras finais passam pela mesma política.

Por padrão, XFF/CF-Connecting-IP são ignorados. Atrás do túnel local os clientes
compartilham o bucket do socket do cloudflared. Para distingui-los, configure
explicitamente o IP confiável e header somente depois de garantir que tráfego
não confiável não possa atingir esse ingresso fingindo ser o proxy. XFF é
percorrido da direita para a esquerda; IPs inválidos são ignorados. Um proxy
loopback compartilhado com outros clientes locais não oferece essa garantia.

Os testes cobrem upstream HTTP com URL canônica HTTPS, cookie Secure e peer
real em porta efêmera com headers forjados. O túnel/redirect do autor não foram
alterados; o backend novo não foi colocado na porta 3000. Não há homologação
end-to-end deste backend pelo túnel público nesta entrega. SameSite=Lax requer
uma implantação de UI/API no mesmo site para cookies no navegador; localhost
e um domínio trycloudflare são sites distintos. Usar o mesmo hostname local em
desenvolvimento; a TASK-014 tratará a confirmação de callback em host diferente.

## Reprodução de QA

Na worktree TASK-005 há `.env` privado próprio, sem credenciais Mercado Livre,
com `omnihub_task005_dev` e `omnihub_task005_test_db` no PostgreSQL local existente.
Nenhuma migration foi aplicada ao banco principal. Não copiar o `.env` ao cofre.

```powershell
bun install
bun run db:generate
bun run db:migrate
bun run typecheck
bun test
bun run auth:turnstile-smoke
```

Conferir os destinos privados antes de migrations/testes. A suíte usa
TEST_DATABASE_URL distinta com `test` no nome; não deve haver skips por ausência
da variável. O ensaio de upgrade preservou produto/saldos/reserva, pedido/ledger,
snapshot e três tentativas ERP esgotadas do schema 0000–0003 ao adicionar 0004.
A migration também foi aplicada do zero no banco de teste, e é reaplicável.
Saídas sanitizadas e fonte exato da rodada estão em `output/task-005` e no log
do cofre. TASK-005 foi concluída após QA independente: 228 testes aprovados,
zero falhas/skips, typecheck e migrations em bancos dedicados. A implementação
foi integrada e publicada na develop no commit 7404406a4fe1e375728232467648495198d7cd7e.
A worktree task-005-auth foi removida após preservar os artefatos. A rodada final e seus limites estão
em logs/2026-11-12-task-005-qa.md no cofre; telas, isolamento do domínio e conexões
por usuário continuam nas TASK-006/013/014.

## Fontes oficiais consultadas em 2026-11-12

- [Cloudflare: validação, validade e convergência de reuso](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).
- [Cloudflare: chaves e resposta dummy](https://developers.cloudflare.com/turnstile/troubleshooting/testing/).
- [Bun: Argon2id assíncrono e parâmetros](https://bun.com/docs/runtime/hashing).
- [jose: assinatura e validação de claims](https://github.com/panva/jose/blob/main/docs/README.md).
- [Cloudflare: headers do proxy](https://developers.cloudflare.com/fundamentals/reference/http-headers/).
- [Cloudflare: proteção contra spoof ao restaurar IP](https://developers.cloudflare.com/support/troubleshooting/restoring-visitor-ips/restoring-original-visitor-ips/).
- [OWASP: sessões](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) e [CSRF](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

Cadastro desta PoC ainda não oferece verificação/recuperação por e-mail,
equipes, administração multiempresa ou serviço público de produção homologado.
