import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { authSessions, products, users, workspaces } from '@omnihub/database';
import { eq, inArray, sql } from 'drizzle-orm';
import { decodeJwt, SignJWT } from 'jose';
import { createApp } from '../src/app';
import { loadSecurityEnv } from '../src/config/security';
import { AuthService, requireSensitiveAction, type AccountSession } from '../src/plugins/auth';
import { createTurnstileVerifier, type SiteverifyFetch } from '../src/plugins/turnstile';
import { databaseFixture, testDatabaseUrl } from './helpers';

const origin = 'http://localhost:5173';
const environment = { NODE_ENV: 'test', PUBLIC_HUB_URL: 'http://localhost', CORS_ORIGINS: origin, JWT_SECRET: 'integration-only-private-key-'.repeat(3), CLOUDFLARE_TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' };
const config = loadSecurityEnv(environment);
const operator = 'only-local-operator-tests-'.repeat(3);
const password = 'only-tests-password-123';
const approved: SiteverifyFetch = async () => Response.json({ success: true, hostname: 'example.com' });

describe.skipIf(!testDatabaseUrl)('conta HTTP com PostgreSQL dedicado', () => {
  const fixture = databaseFixture();
  const emails = new Set<string>();
  afterEach(async () => {
    if (emails.size) await fixture.db.delete(users).where(inArray(users.email, [...emails]));
    emails.clear();
  });
  function identity() {
    const email = `task005-${Bun.randomUUIDv7()}@example.invalid`; emails.add(email);
    return { name: 'Lojista Sintético', email, password, turnstileToken: 'dummy-token' };
  }
  function setup(security = config, siteverifyFetch: SiteverifyFetch = approved) {
    const app = createApp({ db: fixture.db, security, siteverifyFetch, corsOrigins: [origin],
      runtime: { adminToken: operator, webhookSecret: 'test-erp-hmac-'.repeat(4), erpUrl: 'http://127.0.0.1:3306', mockAdminToken: operator } });
    const request = (path: string, options: { method?: string; body?: unknown; cookie?: string; csrf?: string; headers?: Record<string,string>; url?: string } = {}) => app.handle(new Request(options.url ?? `http://localhost${path}`, {
      method: options.method ?? (options.body ? 'POST' : 'GET'),
      headers: { ...(options.method === 'POST' || options.body ? { origin } : {}), ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.csrf ? { 'x-csrf-token': options.csrf } : {}), ...options.headers },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    }));
    return { app, request };
  }
  async function register(h = setup(), input = identity()) {
    const response = await h.request('/api/auth/register', { body: input });
    expect(response.status).toBe(201);
    const account = await response.json() as AccountSession;
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    return { h, input, response, account, cookie };
  }

  test('cadastro normaliza e-mail/nome, usa Argon2id, cria workspace vazio e cookie privado', async () => {
    const h = setup(), input = identity();
    const [before] = await fixture.db.select({ count: sql<number>`count(*)::int` }).from(products);
    const registered = await register(h, { ...input, name: '  Lojista Sintético  ', email: ` ${input.email.toUpperCase()} ` });
    expect(registered.account.user).toMatchObject({ name: input.name, email: input.email });
    expect(registered.account.workspace.name).toBe('Meu negócio');
    expect(registered.account.csrfToken.length).toBeGreaterThanOrEqual(40);
    const cookie = registered.response.headers.get('set-cookie')!;
    for (const flag of ['HttpOnly','SameSite=Lax','Path=/','Max-Age=3600']) expect(cookie).toContain(flag);
    expect(cookie).not.toContain('Domain'); expect(cookie).not.toContain('Secure');
    expect(registered.response.headers.get('cache-control')).toBe('no-store');
    const [stored] = await fixture.db.select().from(users).where(eq(users.id, registered.account.user.id));
    expect(stored!.passwordHash).toStartWith('$argon2id$');
    expect(await Bun.password.verify(password, stored!.passwordHash)).toBe(true);
    const text = JSON.stringify(registered.account);
    for (const secret of [password, stored!.passwordHash, registered.cookie.split('=')[1]!, operator, config.jwtSecret]) expect(text).not.toContain(secret);
    expect(await fixture.db.select().from(workspaces).where(eq(workspaces.ownerId, stored!.id))).toHaveLength(1);
    expect((await fixture.db.select({ count: sql<number>`count(*)::int` }).from(products))[0]!.count).toBe(before!.count);
    const session = await h.request('/api/auth/session', { cookie: registered.cookie });
    expect(session.status).toBe(200); expect(await session.json()).toEqual(registered.account);
  });

  test('cadastros concorrentes/duplicados normalizados criam exatamente uma conta/workspace/sessão', async () => {
    const h = setup(), input = identity();
    const responses = await Promise.all([input.email, input.email.toUpperCase(), ` ${input.email} `].map(email => h.request('/api/auth/register', { body: { ...input, email } })));
    expect(responses.map(response => response.status).sort()).toEqual([201,409,409]);
    const [user] = await fixture.db.select().from(users).where(eq(users.email, input.email));
    expect(await fixture.db.select().from(workspaces).where(eq(workspaces.ownerId,user!.id))).toHaveLength(1);
    expect(await fixture.db.select().from(authSessions).where(eq(authSessions.userId,user!.id))).toHaveLength(1);
    expect((await h.request('/api/auth/register',{body:input})).status).toBe(409);
  });

  test('validação de cadastro impede nome vazio, e-mail inválido e senha curta', async () => {
    const h = setup(), input = identity();
    for (const patch of [{name:'   '},{email:'invalid-address'},{password:'short'}]) {
      expect((await h.request('/api/auth/register',{body:{...input,...patch}})).status).toBe(422);
    }
    expect(await fixture.db.select().from(users).where(eq(users.email,input.email))).toHaveLength(0);
  });

  test('erro antes do commit reverte usuário, workspace e sessão e oculta causa', async () => {
    const h = setup(), input = identity();
    const before = await fixture.db.select({ count: sql<number>`count(*)::int` }).from(workspaces);
    const transaction = fixture.db.transaction.bind(fixture.db);
    const failing = spyOn(fixture.db, 'transaction').mockImplementation(callback => transaction(async tx => { await callback(tx); throw new Error('synthetic private rollback'); }));
    const logging = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await h.request('/api/auth/register',{body:input});
      expect(response.status).toBe(500); expect(await response.text()).not.toContain('private rollback');
    } finally { failing.mockRestore(); logging.mockRestore(); }
    expect(await fixture.db.select().from(users).where(eq(users.email,input.email))).toHaveLength(0);
    expect(await fixture.db.select({ count: sql<number>`count(*)::int` }).from(workspaces)).toEqual(before);
    const orphans = await fixture.db.execute(sql`select id from auth_sessions where user_id not in (select id from users)`);
    expect(orphans).toHaveLength(0);
  });

  test('senha inválida e conta desconhecida retornam mesmo erro; login emite outra sessão', async () => {
    const r = await register();
    const errors = [];
    for (const input of [{email:r.input.email,password:'incorrect'}, {email:identity().email,password}]) {
      const response = await r.h.request('/api/auth/login',{body:{...input,turnstileToken:'dummy-token'}});
      expect(response.status).toBe(401); errors.push(await response.json());
      expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    }
    expect(errors[0]).toEqual(errors[1]);
    const response = await r.h.request('/api/auth/login',{body:{email:r.input.email.toUpperCase(),password,turnstileToken:'dummy-token'}});
    expect(response.status).toBe(200); expect(response.headers.get('set-cookie')).not.toContain(r.cookie);
    expect(await response.json()).toMatchObject({user:r.account.user,workspace:r.account.workspace});
  });

  test('JWT adulterado, ausência/duplicação do cookie e bearer JWT falham e limpam cookie', async () => {
    const r = await register();
    for (const options of [
      {}, { cookie: `${r.cookie}x` }, { cookie: `${r.cookie}; ${r.cookie}` },
      { headers:{authorization:`Bearer ${r.cookie.split('=')[1]}`} },
    ]) {
      const response = await r.h.request('/api/auth/session',options);
      expect(response.status).toBe(401); expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    }
  });

  test('valida todos os claims, algoritmo, tempo e vínculo persistido; JWT válido não cria sessão', async () => {
    const r = await register();
    const original = decodeJwt(r.cookie.split('=')[1]!);
    const now = Math.floor(Date.now()/1000);
    const patches = [
      {iss:'https://other.example'}, {aud:'other'}, {sub:Bun.randomUUIDv7()}, {sid:Bun.randomUUIDv7()}, {sub:'invalid'}, {sid:'invalid'},
      {iat:now+60}, {iat:now-3601,exp:now-1}, {iat:now-1,exp:now+7200}, {exp:now+100}, {iat:now-1}, {exp:now+0.5},
    ];
    for (const patch of patches) {
      const token = await new SignJWT({...original,...patch}).setProtectedHeader({alg:'HS256',typ:'JWT'}).sign(new TextEncoder().encode(config.jwtSecret));
      expect((await r.h.request('/api/auth/session',{cookie:`omnihub_session=${token}`})).status).toBe(401);
    }
    for (const claim of ['sub','sid','iss','aud','iat','exp']) {
      const claims = {...original}; delete claims[claim];
      const token = await new SignJWT(claims).setProtectedHeader({alg:'HS256',typ:'JWT'}).sign(new TextEncoder().encode(config.jwtSecret));
      expect((await r.h.request('/api/auth/session',{cookie:`omnihub_session=${token}`})).status).toBe(401);
    }
    const wrongAlg = await new SignJWT(original).setProtectedHeader({alg:'HS384',typ:'JWT'}).sign(new TextEncoder().encode(config.jwtSecret));
    expect((await r.h.request('/api/auth/session',{cookie:`omnihub_session=${wrongAlg}`})).status).toBe(401);
    const sid = String(original.sid);
    await fixture.db.update(authSessions).set({revokedAt:new Date()}).where(eq(authSessions.id,sid));
    expect((await r.h.request('/api/auth/session',{cookie:r.cookie})).status).toBe(401);
  });

  test('expiração persistida invalida cookie mesmo com assinatura válida', async () => {
    const r = await register(), claims = decodeJwt(r.cookie.split('=')[1]!);
    await fixture.db.update(authSessions).set({issuedAt:new Date(Date.now()-7200000),expiresAt:new Date(Date.now()-3600000)}).where(eq(authSessions.id,String(claims.sid)));
    expect((await r.h.request('/api/auth/session',{cookie:r.cookie})).status).toBe(401);
  });

  test('logout exige Origin e CSRF da própria sessão, revoga e limpa com flags corretas', async () => {
    const r = await register(), other = await register(r.h);
    for (const csrf of [undefined,'wrong',other.account.csrfToken]) {
      const response = await r.h.request('/api/auth/logout',{method:'POST',cookie:r.cookie,csrf});
      expect(response.status).toBe(403); expect(await response.json()).toMatchObject({error:{code:'CSRF_INVALID'}});
    }
    expect((await r.h.request('/api/auth/logout',{method:'POST',cookie:r.cookie,csrf:r.account.csrfToken,headers:{origin:'https://evil.example'}})).status).toBe(403);
    const response = await r.h.request('/api/auth/logout',{method:'POST',cookie:r.cookie,csrf:r.account.csrfToken});
    expect(response.status).toBe(204); expect(await response.text()).toBe('');
    for (const flag of ['Max-Age=0','HttpOnly','SameSite=Lax','Path=/','Expires=Thu, 01 Jan 1970']) expect(response.headers.get('set-cookie')).toContain(flag);
    expect((await r.h.request('/api/auth/session',{cookie:r.cookie})).status).toBe(401);
    expect((await r.h.request('/api/auth/session',{cookie:other.cookie})).status).toBe(200);
  });

  test('pré-login rejeita Origin ausente/nulo/falso e mídia não JSON', async () => {
    const h = setup(), input = identity();
    for (const route of ['register','login']) {
      for (const value of ['', 'null','https://evil.example',`${origin}.evil.example`]) {
        const response = await h.request(`/api/auth/${route}`,{body:input,headers:{origin:value,'x-forwarded-host':'localhost:5173'}});
        expect(response.status).toBe(403); expect(await response.json()).toMatchObject({error:{code:'ORIGIN_NOT_ALLOWED'}});
      }
    }
    const response = await setup().request('/api/auth/register',{body:input,headers:{'content-type':'application/x-www-form-urlencoded'}});
    expect(response.status).toBe(415);
    const absent = await setup().app.handle(new Request('http://localhost/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}));
    expect(absent.status).toBe(403);
  });

  test('Turnstile ausente, recusado, timeout e reutilização não criam conta', async () => {
    let calls = 0;
    const h = setup(config, async () => { calls++; return Response.json({success:false,'error-codes':['timeout-or-duplicate']}); });
    const input = identity();
    for (const turnstileToken of [undefined,'expired','reused']) {
      const response = await h.request('/api/auth/register',{body:{...input,turnstileToken}});
      expect(response.status).toBe(403); expect(await response.json()).toMatchObject({error:{code:'TURNSTILE_CHALLENGE_FAILED'}});
    }
    expect(calls).toBe(2);
    const timeout = setup({...config,turnstileTimeoutMs:20},async()=>new Promise<Response>(()=>{}));
    expect((await timeout.request('/api/auth/register',{body:input})).status).toBe(403);
    expect(await fixture.db.select().from(users).where(eq(users.email,input.email))).toHaveLength(0);
  });

  test('10 tentativas de login/cadastro compartilham bucket e spoof de headers não evita 429', async () => {
    const h = setup(), input = identity();
    for(let i=0;i<10;i++) {
      const response = await h.request(`/api/auth/${i%2?'register':'login'}${i%2?'/':''}`,{body:{...input,turnstileToken:''},headers:{'x-forwarded-for':`192.0.2.${i+1}`,'cf-connecting-ip':`192.0.2.${i+1}`}});
      expect(response.status).toBe(403);
    }
    const limited = await h.request('/api/auth/login',{body:input});
    expect(limited.status).toBe(429); expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(limited.headers.get('access-control-allow-origin')).toBe(origin);
    expect(await limited.json()).toMatchObject({error:{code:'RATE_LIMITED'}});
    expect((await h.request('/api/auth/session')).status).toBe(401);
  });

  test('barra final preserva Origin/JSON, autorização operacional e callback M2M', async () => {
    const h = setup(), input = identity();
    expect((await h.request('/api/auth/login/',{body:input,headers:{origin:'https://evil.example'}})).status).toBe(403);
    expect((await h.request('/api/auth/login/',{body:input,headers:{'content-type':'text/plain'}})).status).toBe(415);
    expect((await h.request('/api/v1/inventory/')).status).toBe(401);
    expect((await h.request('/api/oauth/meli/start/',{method:'POST'})).status).toBe(403);
    expect((await h.request('/api/oauth/meli/callback/')).status).toBe(503);
  });

  test('HTTPS externo mantém cookie Secure no upstream HTTP; headers não relaxam política', async () => {
    const https = loadSecurityEnv({...environment,PUBLIC_HUB_URL:'https://hub.example.com'});
    const r = await register(setup(https));
    expect(r.response.headers.get('set-cookie')).toContain('; Secure');
    expect(r.response.headers.get('set-cookie')).not.toContain('Domain');
    const response = await r.h.request('/api/auth/logout',{method:'POST',cookie:r.cookie,csrf:r.account.csrfToken,headers:{'x-forwarded-proto':'http'}});
    expect(response.status).toBe(204); expect(response.headers.get('set-cookie')).toContain('; Secure');
    const remoteHttp = await setup().request('/api/auth/session',{url:'http://public.example/api/auth/session',headers:{'x-forwarded-proto':'https'}});
    expect(remoteHttp.status).toBe(403);
  });

  test('CORS permite credenciais/CSRF somente à origem explícita e responde preflight', async () => {
    const h = setup();
    const allowed = await h.app.handle(new Request('http://localhost/api/auth/logout',{method:'OPTIONS',headers:{origin,'access-control-request-method':'POST','access-control-request-headers':'content-type,x-csrf-token'}}));
    expect(allowed.status).toBe(204); expect(allowed.headers.get('access-control-allow-origin')).toBe(origin);
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');
    expect(allowed.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('x-csrf-token');
    const denied = await h.request('/api/auth/session',{headers:{origin:'https://evil.example'}});
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('sessão comum não acessa nenhum dado/mutação global ou OAuth administrativo', async () => {
    const r = await register();
    const product = await fixture.product();
    const routes = ['/api/v1/inventory',`/api/v1/inventory/${product.sku}/ledger`, '/api/v1/dashboard/orders','/api/v1/dashboard/processings',`/api/v1/dashboard/processings/${Bun.randomUUIDv7()}`,
      '/api/v1/dashboard/mappings','/api/v1/dashboard/metrics','/api/v1/dashboard/connections'];
    for (const path of routes) {
      const response = await r.h.request(path,{cookie:r.cookie}); expect(response.status).toBe(401);
      expect(await response.text()).not.toContain(product.sku);
    }
    for (const path of ['/api/v1/dashboard/mappings',`/api/v1/dashboard/processings/${Bun.randomUUIDv7()}/retry`,'/api/v1/dashboard/connections/check','/api/oauth/meli/start','/api/oauth/meli/smoke']) {
      expect((await r.h.request(path,{method:'POST',cookie:r.cookie,csrf:r.account.csrfToken})).status).toBe(403);
    }
    expect((await r.h.request('/api/v1/inventory',{headers:{authorization:`Bearer ${operator}`}})).status).toBe(200);
    expect((await r.h.request('/api/v1/inventory',{headers:{authorization:`Bearer ${operator}`,origin}})).status).toBe(403);
    expect((await r.h.request('/api/v1/inventory')).status).toBe(401);
  });

  test('sessão resolve somente sua conta/workspace sem aceitar contexto arbitrário do cliente', async () => {
    const r = await register(), other = await register(r.h);
    expect(r.account.workspace.id).not.toBe(other.account.workspace.id);
    const response = await r.h.request(`/api/auth/session?workspaceId=${other.account.workspace.id}`,{
      cookie:r.cookie,headers:{'x-workspace-id':other.account.workspace.id,'x-user-id':other.account.user.id},
    });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(r.account);
  });

  test('proteção reutilizável exige sessão, Origin, CSRF e desafio vinculado; polling não desafia', async () => {
    const r = await register();
    const auth = new AuthService(fixture.db,config);
    const request = new Request('http://localhost/future',{method:'POST',headers:{origin,cookie:r.cookie,'x-csrf-token':r.account.csrfToken}});
    let contexts = 0;
    const verify = async (_token: string, _ip?: string, context?: {action:string;cdata?:string}) => {
      contexts++; expect(context).toEqual({action:'connect',cdata:r.account.csrfToken}); return true;
    };
    expect((await requireSensitiveAction(request,auth,[origin],verify,{token:'token',ip:'127.0.0.1',action:'connect'})).account.user.id).toBe(r.account.user.id);
    expect(contexts).toBe(1);
    await expect(requireSensitiveAction(request,auth,[origin],async()=>false,{token:'token',ip:'127.0.0.1',action:'connect'})).rejects.toMatchObject({code:'TURNSTILE_CHALLENGE_FAILED'});
    const productionVerifier = createTurnstileVerifier({...config,turnstileDummy:false},async()=>Response.json({success:true,hostname:'localhost',action:'connect',cdata:'another-session',challenge_ts:new Date().toISOString()}));
    await expect(requireSensitiveAction(request,auth,[origin],productionVerifier,{token:'token',ip:'127.0.0.1',action:'connect'})).rejects.toMatchObject({code:'TURNSTILE_CHALLENGE_FAILED'});
    expect((await r.h.request('/api/auth/session',{cookie:r.cookie})).status).toBe(200);
  });
});
