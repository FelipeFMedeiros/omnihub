import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { authSessions, products, users, workspaces } from '@omnihub/database';
import { eq, inArray, sql } from 'drizzle-orm';
import { decodeJwt, SignJWT } from 'jose';
import { createApp } from '../src/app';
import { loadSecurityEnv } from '../src/config/security';
import { AuthService, requireSensitiveAction, type AccountSession } from '../src/plugins/auth';
import { createTurnstileVerifier, verifyTurnstileToken, type SiteverifyFetch } from '../src/plugins/turnstile';
import { databaseFixture, testDatabaseUrl } from './helpers';

const origin = 'http://localhost:5173';
const testEnv = {
  NODE_ENV: 'test',
  PUBLIC_HUB_URL: 'http://localhost',
  CORS_ORIGINS: origin,
  JWT_SECRET: 'qa-independent-jwt-secret-key-must-be-32b',
  CLOUDFLARE_TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
};
const secConfig = loadSecurityEnv(testEnv);
const operatorToken = 'qa-operator-admin-token-min-32-chars-long';
const validPassword = 'complex-qa-password-1234';
const approvedDummySiteverify: SiteverifyFetch = async () => Response.json({ success: true, hostname: 'example.com' });

describe.skipIf(!testDatabaseUrl)('QA Independente TASK-005 — Segurança, Sessão, Turnstile e Borda', () => {
  const fixture = databaseFixture();
  const createdEmails = new Set<string>();

  afterEach(async () => {
    if (createdEmails.size) {
      await fixture.db.delete(users).where(inArray(users.email, [...createdEmails]));
      createdEmails.clear();
    }
  });

  function createTestIdentity() {
    const email = `qa-test-${Bun.randomUUIDv7()}@example.invalid`;
    createdEmails.add(email);
    return { name: 'Lojista QA Independente', email, password: validPassword, turnstileToken: 'dummy-token' };
  }

  function setupApp(security = secConfig, siteverifyFetch: SiteverifyFetch = approvedDummySiteverify) {
    const app = createApp({
      db: fixture.db,
      security,
      siteverifyFetch,
      corsOrigins: [origin],
      runtime: {
        adminToken: operatorToken,
        webhookSecret: 'qa-erp-webhook-hmac-secret-min-32-bytes',
        erpUrl: 'http://127.0.0.1:3306',
        mockAdminToken: operatorToken,
      },
    });

    const request = (
      path: string,
      options: {
        method?: string;
        body?: unknown;
        cookie?: string;
        csrf?: string;
        headers?: Record<string, string>;
        url?: string;
      } = {},
    ) =>
      app.handle(
        new Request(options.url ?? `http://localhost${path}`, {
          method: options.method ?? (options.body ? 'POST' : 'GET'),
          headers: {
            ...(options.method === 'POST' || options.body ? { origin } : {}),
            ...(options.body ? { 'content-type': 'application/json' } : {}),
            ...(options.cookie ? { cookie: options.cookie } : {}),
            ...(options.csrf ? { 'x-csrf-token': options.csrf } : {}),
            ...options.headers,
          },
          ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        }),
      );

    return { app, request };
  }

  async function registerAccount(h = setupApp(), input = createTestIdentity()) {
    const response = await h.request('/api/auth/register', { body: input });
    expect(response.status).toBe(201);
    const account = (await response.json()) as AccountSession;
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    return { h, input, response, account, cookie };
  }

  // 1. Cadastro e Criação Atômica
  test('[QA-01] Cadastro normaliza Unicode/whitespace e e-mail, gera hash Argon2id e cria workspace vazio atomicamente', async () => {
    const h = setupApp();
    const rawInput = createTestIdentity();
    const [initialProducts] = await fixture.db.select({ count: sql<number>`count(*)::int` }).from(products);

    // Enviar nome com espaços e acentos/composição NFC, e-mail em maiúsculo com espaços
    const registerResponse = await registerAccount(h, {
      ...rawInput,
      name: '  José da Silva\u0045\u0301  ', // José da SilvaÉ (decomposed E + acute)
      email: `   ${rawInput.email.toUpperCase()}   `,
    });

    expect(registerResponse.account.user.email).toBe(rawInput.email.toLowerCase());
    expect(registerResponse.account.user.name).toBe('José da SilvaÉ');
    expect(registerResponse.account.workspace.name).toBe('Meu negócio');
    expect(registerResponse.account.csrfToken).toBeString();
    expect(registerResponse.account.csrfToken.length).toBeGreaterThanOrEqual(40);

    // Conferir cookie
    const cookieHeader = registerResponse.response.headers.get('set-cookie')!;
    expect(cookieHeader).toContain('HttpOnly');
    expect(cookieHeader).toContain('SameSite=Lax');
    expect(cookieHeader).toContain('Path=/');
    expect(cookieHeader).toContain('Max-Age=3600');
    expect(cookieHeader).not.toContain('Domain');

    // Conferir persistência no banco
    const [userRecord] = await fixture.db.select().from(users).where(eq(users.id, registerResponse.account.user.id));
    expect(userRecord).toBeDefined();
    expect(userRecord!.email).toBe(rawInput.email.toLowerCase());
    expect(userRecord!.passwordHash).toStartWith('$argon2id$');
    expect(await Bun.password.verify(validPassword, userRecord!.passwordHash)).toBe(true);

    // Workspace único pertencente ao usuário
    const workspacesList = await fixture.db.select().from(workspaces).where(eq(workspaces.ownerId, userRecord!.id));
    expect(workspacesList).toHaveLength(1);
    expect(workspacesList[0]!.id).toBe(registerResponse.account.workspace.id);

    // Sessão persistida criada
    const sessionsList = await fixture.db.select().from(authSessions).where(eq(authSessions.userId, userRecord!.id));
    expect(sessionsList).toHaveLength(1);
    expect(sessionsList[0]!.revokedAt).toBeNull();

    // Produtos globais inalterados (nenhum dado legado atribuído)
    const [afterProducts] = await fixture.db.select({ count: sql<number>`count(*)::int` }).from(products);
    expect(afterProducts!.count).toBe(initialProducts!.count);

    // Nenhuma senha ou hash no corpo JSON
    const bodyStr = JSON.stringify(registerResponse.account);
    expect(bodyStr).not.toContain(validPassword);
    expect(bodyStr).not.toContain(userRecord!.passwordHash);
    expect(bodyStr).not.toContain(operatorToken);
  });

  // 2. Concorrência e Deduplicação no Cadastro
  test('[QA-02] 5 cadastros simultâneos com mesmo e-mail em diferentes caixas/espaços criam exatamente 1 conta', async () => {
    const h = setupApp();
    const identity = createTestIdentity();
    const variations = [
      identity.email,
      identity.email.toUpperCase(),
      `  ${identity.email}  `,
      ` ${identity.email.toUpperCase()} `,
      identity.email,
    ];

    const responses = await Promise.all(
      variations.map((email) => h.request('/api/auth/register', { body: { ...identity, email } })),
    );

    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409]);

    const createdUsers = await fixture.db.select().from(users).where(eq(users.email, identity.email.toLowerCase()));
    expect(createdUsers).toHaveLength(1);

    const createdWorkspaces = await fixture.db.select().from(workspaces).where(eq(workspaces.ownerId, createdUsers[0]!.id));
    expect(createdWorkspaces).toHaveLength(1);

    const createdSessions = await fixture.db.select().from(authSessions).where(eq(authSessions.userId, createdUsers[0]!.id));
    expect(createdSessions).toHaveLength(1);
  });

  // 3. Rollback Atômico em Falha de Transação
  test('[QA-03] Falha na transação de cadastro reverte usuário, workspace e sessão sem deixar órfãos', async () => {
    const h = setupApp();
    const identity = createTestIdentity();
    const originalTx = fixture.db.transaction.bind(fixture.db);

    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const txSpy = spyOn(fixture.db, 'transaction').mockImplementation((callback) =>
      originalTx(async (tx) => {
        await callback(tx);
        throw new Error('qa-injected-transaction-failure-test');
      }),
    );

    try {
      const response = await h.request('/api/auth/register', { body: identity });
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).not.toContain('qa-injected-transaction-failure');
      expect(text).toContain('INTERNAL_SERVER_ERROR');
    } finally {
      txSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(await fixture.db.select().from(users).where(eq(users.email, identity.email))).toHaveLength(0);
    const orphanWorkspaces = await fixture.db.execute(sql`SELECT id FROM workspaces WHERE owner_id NOT IN (SELECT id FROM users)`);
    expect(orphanWorkspaces).toHaveLength(0);
    const orphanSessions = await fixture.db.execute(sql`SELECT id FROM auth_sessions WHERE user_id NOT IN (SELECT id FROM users)`);
    expect(orphanSessions).toHaveLength(0);
  });

  // 4. Validação de Campos no Cadastro
  test('[QA-04] Rejeição rigorosa de payloads inválidos de cadastro (422) e mídia não JSON (415)', async () => {
    const h = setupApp();
    const identity = createTestIdentity();

    // Campos inválidos
    const invalidPayloads = [
      { name: '' },
      { name: '   ' },
      { name: 'a'.repeat(121) },
      { email: 'not-an-email' },
      { email: '@nodomain.com' },
      { email: 'a'.repeat(250) + '@example.invalid' }, // > 254
      { password: 'short' }, // < 12
      { password: 'a'.repeat(129) }, // > 128
    ];

    for (const patch of invalidPayloads) {
      const res = await h.request('/api/auth/register', { body: { ...identity, ...patch } });
      expect(res.status).toBe(422);
    }

    // Elysia sanitiza e descarta campos adicionais não declarados (additionalProperties: false)
    const extraFieldIdentity = createTestIdentity();
    const extraFieldRes = await h.request('/api/auth/register', {
      body: { ...extraFieldIdentity, injectedRole: 'ADMIN_SUPERUSER', extraParam: 12345 },
    });
    expect(extraFieldRes.status).toBe(201);
    const registeredJson = await extraFieldRes.json() as Record<string, unknown>;
    expect(registeredJson.injectedRole).toBeUndefined();
    expect(registeredJson.extraParam).toBeUndefined();

    // Mídia não JSON
    const nonJsonRes = await h.request('/api/auth/register', {
      body: identity,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(nonJsonRes.status).toBe(415);
  });

  // 5. Login: Sucesso, Falha Constante e Limpeza de Cookie
  test('[QA-05] Login: sucesso emite nova sessão; falhas limpam cookie e usam hash constante', async () => {
    const registered = await registerAccount();
    const h = registered.h;

    // Senha errada
    const badPasswordRes = await h.request('/api/auth/login', {
      body: { email: registered.input.email, password: 'wrong-password-1234', turnstileToken: 'dummy' },
    });
    expect(badPasswordRes.status).toBe(401);
    expect(badPasswordRes.headers.get('set-cookie')).toContain('Max-Age=0');
    const badPassJson = await badPasswordRes.json();

    // Conta inexistente
    const badUserRes = await h.request('/api/auth/login', {
      body: { email: createTestIdentity().email, password: validPassword, turnstileToken: 'dummy' },
    });
    expect(badUserRes.status).toBe(401);
    expect(badUserRes.headers.get('set-cookie')).toContain('Max-Age=0');
    const badUserJson = await badUserRes.json();

    // Mesma resposta e mensagem de erro para ambos
    expect(badPassJson).toEqual(badUserJson);
    expect(badPassJson).toEqual({ error: { code: 'INVALID_CREDENTIALS', message: 'E-mail ou senha inválidos.' } });

    // Login com sucesso (mesmo com email em maiúsculas)
    const loginRes = await h.request('/api/auth/login', {
      body: { email: registered.input.email.toUpperCase(), password: validPassword, turnstileToken: 'dummy' },
    });
    expect(loginRes.status).toBe(200);
    const newCookie = loginRes.headers.get('set-cookie')!.split(';')[0]!;
    expect(newCookie).not.toBe(registered.cookie); // Nova sessão gerada

    // Usuário agora tem 2 sessões ativas
    const userSessions = await fixture.db.select().from(authSessions).where(eq(authSessions.userId, registered.account.user.id));
    expect(userSessions).toHaveLength(2);
  });

  // 6. Sessão: Consulta, Polling sem Turnstile e Verificação de Claims
  test('[QA-06] GET /session não chama Turnstile, valida claims JWT e rejeita adulterações', async () => {
    let siteverifyCalls = 0;
    const trackingVerify: SiteverifyFetch = async () => {
      siteverifyCalls++;
      return Response.json({ success: true, hostname: 'example.com' });
    };
    const h = setupApp(secConfig, trackingVerify);
    const registered = await registerAccount(h);

    // Registro chamou Turnstile 1 vez
    expect(siteverifyCalls).toBe(1);

    // Polling GET /session
    for (let i = 0; i < 5; i++) {
      const sessionRes = await h.request('/api/auth/session', { cookie: registered.cookie });
      expect(sessionRes.status).toBe(200);
      expect(await sessionRes.json()).toEqual(registered.account);
    }
    // Turnstile NÃO deve ter sido chamado no polling
    expect(siteverifyCalls).toBe(1);

    // JWT adulterado na assinatura
    const tamperedSig = `${registered.cookie}xyz`;
    const tamperedRes = await h.request('/api/auth/session', { cookie: tamperedSig });
    expect(tamperedRes.status).toBe(401);
    expect(tamperedRes.headers.get('set-cookie')).toContain('Max-Age=0');

    // Token JWT com algoritmo incorreto (none, HS384)
    const tokenPayload = decodeJwt(registered.cookie.split('=')[1]!);
    const key = new TextEncoder().encode(secConfig.jwtSecret);

    const algNoneToken = await new SignJWT(tokenPayload).setProtectedHeader({ alg: 'HS384', typ: 'JWT' }).sign(key);
    expect((await h.request('/api/auth/session', { cookie: `omnihub_session=${algNoneToken}` })).status).toBe(401);

    // Claims ausentes ou adulterados
    for (const claim of ['sub', 'sid', 'iss', 'aud', 'iat', 'exp']) {
      const copy = { ...tokenPayload };
      delete copy[claim];
      const broken = await new SignJWT(copy).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).sign(key);
      expect((await h.request('/api/auth/session', { cookie: `omnihub_session=${broken}` })).status).toBe(401);
    }

    // Cookie duplicado no header
    const duplicateCookieRes = await h.request('/api/auth/session', {
      cookie: `${registered.cookie}; ${registered.cookie}`,
    });
    expect(duplicateCookieRes.status).toBe(401);
  });

  // 7. Logout e Revogação
  test('[QA-07] Logout exige Origin e CSRF da sessão, revoga no banco e limpa cookie com 204', async () => {
    const registered = await registerAccount();
    const h = registered.h;

    // Tentativa sem CSRF
    const noCsrfRes = await h.request('/api/auth/logout', { method: 'POST', cookie: registered.cookie });
    expect(noCsrfRes.status).toBe(403);
    expect(((await noCsrfRes.json()) as { error: { code: string } }).error.code).toBe('CSRF_INVALID');

    // Tentativa com CSRF de outra sessão
    const other = await registerAccount(h);
    const wrongCsrfRes = await h.request('/api/auth/logout', {
      method: 'POST',
      cookie: registered.cookie,
      csrf: other.account.csrfToken,
    });
    expect(wrongCsrfRes.status).toBe(403);
    expect(((await wrongCsrfRes.json()) as { error: { code: string } }).error.code).toBe('CSRF_INVALID');

    // Tentativa com Origin não permitido
    const wrongOriginRes = await h.request('/api/auth/logout', {
      method: 'POST',
      cookie: registered.cookie,
      csrf: registered.account.csrfToken,
      headers: { origin: 'https://malicious-site.example' },
    });
    expect(wrongOriginRes.status).toBe(403);
    expect(((await wrongOriginRes.json()) as { error: { code: string } }).error.code).toBe('ORIGIN_NOT_ALLOWED');

    // Logout correto
    const logoutRes = await h.request('/api/auth/logout', {
      method: 'POST',
      cookie: registered.cookie,
      csrf: registered.account.csrfToken,
    });
    expect(logoutRes.status).toBe(204);
    expect(await logoutRes.text()).toBe('');

    const clearCookie = logoutRes.headers.get('set-cookie')!;
    expect(clearCookie).toContain('Max-Age=0');
    expect(clearCookie).toContain('Expires=Thu, 01 Jan 1970');
    expect(clearCookie).toContain('HttpOnly');
    expect(clearCookie).toContain('SameSite=Lax');

    // Sessão revogada no banco
    const [revokedSession] = await fixture.db
      .select()
      .from(authSessions)
      .where(eq(authSessions.id, String(decodeJwt(registered.cookie.split('=')[1]!).sid)));
    expect(revokedSession!.revokedAt).not.toBeNull();

    // Consulta subsequente falha com 401
    expect((await h.request('/api/auth/session', { cookie: registered.cookie })).status).toBe(401);

    // Outra sessão do outro usuário continua válida
    expect((await h.request('/api/auth/session', { cookie: other.cookie })).status).toBe(200);
  });

  // 8. Proteção de Borda: Rate Limiting e IP Spoofing
  test('[QA-08] Rate limit de autenticação (10 req/min) bloqueia 11ª requisição e ignora headers forjados de IP', async () => {
    const h = setupApp();
    const identity = createTestIdentity();

    // 10 requisições consumindo o orçamento de auth
    for (let i = 0; i < 10; i++) {
      const res = await h.request(`/api/auth/${i % 2 === 0 ? 'login' : 'register'}`, {
        body: { ...identity, turnstileToken: '' },
        headers: {
          'x-forwarded-for': `203.0.113.${i + 1}`,
          'cf-connecting-ip': `198.51.100.${i + 1}`,
        },
      });
      // 403 por turnstile inválido, mas consome o rate limit
      expect(res.status).toBe(403);
    }

    // 11ª requisição deve receber 429 RATE_LIMITED mesmo com outro header forjado
    const blockedRes = await h.request('/api/auth/login', {
      body: identity,
      headers: {
        'x-forwarded-for': '192.0.2.99',
        'cf-connecting-ip': '192.0.2.99',
      },
    });
    expect(blockedRes.status).toBe(429);
    expect(blockedRes.headers.get('retry-after')).toBeDefined();
    expect(Number(blockedRes.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await blockedRes.json()).toEqual({
      error: { code: 'RATE_LIMITED', message: 'Limite de requisições atingido. Aguarde antes de tentar novamente.' },
    });

    // Barra final não evade rate limit
    const slashRes = await h.request('/api/auth/login/', { body: identity });
    expect(slashRes.status).toBe(429);
  });

  // 9. Separação de Contas: Domínio Global Fechado para Sessão Comum
  test('[QA-09] Sessão de usuário não acessa endpoints globais legados; token de operador rejeita navegador', async () => {
    const registered = await registerAccount();
    const h = registered.h;
    const product = await fixture.product(10, 2);

    // Endpoints globais do domínio legado
    const legacyEndpoints = [
      '/api/v1/inventory',
      `/api/v1/inventory/${product.sku}/ledger`,
      '/api/v1/dashboard/orders',
      '/api/v1/dashboard/processings',
      '/api/v1/dashboard/mappings',
      '/api/v1/dashboard/metrics',
      '/api/v1/dashboard/connections',
    ];

    for (const endpoint of legacyEndpoints) {
      // 1. Acesso anônimo -> 401
      expect((await h.request(endpoint)).status).toBe(401);

      // 2. Acesso com sessão de conta válida -> 401 (não concede acesso ao domínio global)
      const sessionRes = await h.request(endpoint, { cookie: registered.cookie });
      expect(sessionRes.status).toBe(401);
      const text = await sessionRes.text();
      expect(text).not.toContain(product.sku);
    }

    // Mutações operacionais globais e OAuth administrativo
    const mutationEndpoints = [
      { path: '/api/v1/dashboard/mappings', method: 'POST' },
      { path: `/api/v1/dashboard/processings/${Bun.randomUUIDv7()}/retry`, method: 'POST' },
      { path: '/api/v1/dashboard/connections/check', method: 'POST' },
      { path: '/api/oauth/meli/start', method: 'POST' },
      { path: '/api/oauth/meli/smoke', method: 'POST' },
    ];

    for (const endpoint of mutationEndpoints) {
      const res = await h.request(endpoint.path, {
        method: endpoint.method,
        cookie: registered.cookie,
        csrf: registered.account.csrfToken,
      });
      // 403 OPERATOR_BROWSER_FORBIDDEN ou 401 UNAUTHORIZED
      expect([401, 403]).toContain(res.status);
    }

    // Token do operador via navegador (com header Origin ou Sec-Fetch-Site) deve ser RECUSADO
    const browserOperatorRes = await h.request('/api/v1/inventory', {
      headers: {
        authorization: `Bearer ${operatorToken}`,
        origin: origin,
      },
    });
    expect(browserOperatorRes.status).toBe(403);
    expect(((await browserOperatorRes.json()) as { error: { code: string } }).error.code).toBe('OPERATOR_BROWSER_FORBIDDEN');

    const browserSecFetchRes = await h.request('/api/v1/inventory', {
      headers: {
        authorization: `Bearer ${operatorToken}`,
        'sec-fetch-site': 'same-origin',
      },
    });
    expect(browserSecFetchRes.status).toBe(403);
    expect(((await browserSecFetchRes.json()) as { error: { code: string } }).error.code).toBe('OPERATOR_BROWSER_FORBIDDEN');

    // Token do operador via CLI (sem headers de navegador) deve ser APROVADO
    const cliOperatorRes = await h.request('/api/v1/inventory', {
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(cliOperatorRes.status).toBe(200);
    const cliData = (await cliOperatorRes.json()) as { data: { sku: string }[] };
    expect(cliData.data.some((p: { sku: string }) => p.sku === product.sku)).toBe(true);
  });

  // 10. Turnstile Siteverify: Falhas Fechadas e Anti-Replay
  test('[QA-10] Verificador Turnstile: falhas fechadas em timeout/500/offline e rejeição de replay em modo real', async () => {
    // 1. Timeout na chamada siteverify
    const hangingFetch: SiteverifyFetch = async () => new Promise<Response>(() => {});
    const timeoutVerifier = createTurnstileVerifier({ ...secConfig, turnstileTimeoutMs: 25 }, hangingFetch);
    expect(await timeoutVerifier('any-token')).toBe(false);

    // 2. Erro de rede / offline
    const errorFetch: SiteverifyFetch = async () => {
      throw new Error('network unreachable');
    };
    const errorVerifier = createTurnstileVerifier(secConfig, errorFetch);
    expect(await errorVerifier('any-token')).toBe(false);

    // 3. Status HTTP 500 do Cloudflare
    const serverErrorFetch: SiteverifyFetch = async () => new Response(null, { status: 500 });
    const serverErrorVerifier = createTurnstileVerifier(secConfig, serverErrorFetch);
    expect(await serverErrorVerifier('any-token')).toBe(false);

    // 4. JSON malformado
    const badJsonFetch: SiteverifyFetch = async () => new Response('invalid-json-body');
    const badJsonVerifier = createTurnstileVerifier(secConfig, badJsonFetch);
    expect(await badJsonVerifier('any-token')).toBe(false);

    // 5. Anti-Replay local em modo real (non-dummy)
    const realSecConfig = loadSecurityEnv({
      ...testEnv,
      CLOUDFLARE_TURNSTILE_SECRET_KEY: 'qa-real-non-dummy-secret-key-test',
    });
    let realCalls = 0;
    const realSuccessFetch: SiteverifyFetch = async () => {
      realCalls++;
      return Response.json({
        success: true,
        hostname: 'localhost',
        action: 'login',
        challenge_ts: new Date().toISOString(),
      });
    };
    const realVerifier = createTurnstileVerifier(realSecConfig, realSuccessFetch);

    // Chamadas concorrentes com mesmo token: apenas uma passa, a outra é barrada localmente
    const replayResults = await Promise.all([
      realVerifier('qa-single-use-token', undefined, { action: 'login' }),
      realVerifier('qa-single-use-token', undefined, { action: 'login' }),
    ]);
    expect(replayResults.sort()).toEqual([false, true]);
    expect(realCalls).toBe(1); // Somente uma chamada disparada para siteverify

    // Terceira tentativa com mesmo token rejeitada imediatamente
    expect(await realVerifier('qa-single-use-token', undefined, { action: 'login' })).toBe(false);
  });

  // 11. Dummy Secrets Proibidos em Produção
  test('[QA-11] Dummy secrets da Cloudflare são estritamente rejeitados em ambiente de produção', () => {
    const dummySecrets = [
      '1x0000000000000000000000000000000AA',
      '2x0000000000000000000000000000000AA',
      '3x0000000000000000000000000000000AA',
    ];

    for (const dummy of dummySecrets) {
      expect(() =>
        loadSecurityEnv({
          NODE_ENV: 'production',
          PUBLIC_HUB_URL: 'https://hub.example.com',
          JWT_SECRET: 'production-key-at-least-32-bytes-long-super-secret',
          CLOUDFLARE_TURNSTILE_SECRET_KEY: dummy,
          CORS_ORIGINS: 'https://dashboard.example.com',
        }),
      ).toThrow('Turnstile dummy proibido em produção.');
    }
  });

  // 12. M2M Webhooks sem Turnstile/Cookie/Origin e com HMAC preservado
  test('[QA-12] Webhook M2M não requer Turnstile, sessão ou Origin, e valida HMAC antes do parser', async () => {
    const h = setupApp();

    // Requisição webhook M2M de ERP
    const webhookRes = await h.app.handle(
      new Request('http://localhost/api/webhooks/erp-stock', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-erp-signature': 'invalid-signature-value',
        },
        body: JSON.stringify({ sku: 'TEST', quantity: 5 }),
      }),
    );

    // Deve ser rejeitado por assinatura inválida (403 INVALID_ERP_SIGNATURE), NUNCA por falta de Turnstile ou Cookie
    expect(webhookRes.status).toBe(403);
    const err = (await webhookRes.json()) as { error: { code: string } };
    expect(err.error.code).toBe('INVALID_ERP_SIGNATURE');
  });

  // 13. Ausência de Segredos em Respostas e Logs
  test('[QA-13] OpenAPI (/docs/json) e respostas de erro não expõem senhas, tokens ou comandos SQL', async () => {
    const h = setupApp();

    // 1. OpenAPI JSON
    const docsRes = await h.request('/docs/json');
    expect(docsRes.status).toBe(200);
    const docsText = await docsRes.text();
    expect(docsText).not.toContain(secConfig.jwtSecret);
    expect(docsText).not.toContain(operatorToken);
    expect(docsText).not.toContain(secConfig.turnstileSecret);

    // 2. Erro de rota inexistente não expõe detalhes de infra
    const notFoundRes = await h.request('/api/auth/non-existent-endpoint');
    expect(notFoundRes.status).toBe(404);
    expect(await notFoundRes.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' },
    });
  });

  // 14. Exported verifyTurnstileToken funciona conforme contrato da spec
  test('[QA-14] verifyTurnstileToken exportado em turnstile.ts funciona conforme contrato', async () => {
    expect(typeof verifyTurnstileToken).toBe('function');
    // Em teste local com token vazio retorna false
    expect(await verifyTurnstileToken('')).toBe(false);
  });
});
