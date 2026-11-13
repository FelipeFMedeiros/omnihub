import { describe, expect, test } from 'bun:test';
import { loadSecurityEnv } from '../../src/config/security';
import { clientIp, EdgeRateLimiter } from '../../src/plugins/rate-limit';
import { createTurnstileVerifier, type SiteverifyFetch } from '../../src/plugins/turnstile';

const environment = {
  NODE_ENV: 'test', PUBLIC_HUB_URL: 'http://localhost', JWT_SECRET: 'unit-tests-private-key-'.repeat(3),
  CLOUDFLARE_TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
  CORS_ORIGINS: 'http://localhost:5173',
};
const config = loadSecurityEnv(environment);
const real = loadSecurityEnv({ ...environment, CLOUDFLARE_TURNSTILE_SECRET_KEY: 'synthetic-real-key-for-mocked-server' });
const approved = () => ({ success: true, hostname: 'localhost', action: 'login', cdata: 'session-binding', challenge_ts: new Date().toISOString() });
const mockVerify = (value: unknown, settings = real) => createTurnstileVerifier(settings, async () => Response.json(value));

describe('siteverify obrigatório e falhas fechadas', () => {
  test('chama host oficial, secret no corpo, IP válido e sinal de cancelamento', async () => {
    let calls = 0;
    const transport: SiteverifyFetch = async (url, init) => {
      calls++; expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
      expect(init.method).toBe('POST'); expect(init.redirect).toBe('error'); expect(init.signal).toBeInstanceOf(AbortSignal);
      const body = new URLSearchParams(String(init.body));
      expect(body.get('secret')).toBe(config.turnstileSecret); expect(body.get('response')).toBe('dummy-token'); expect(body.get('remoteip')).toBe('127.0.0.1');
      return Response.json({ success: true, hostname: 'example.com' });
    };
    expect(await createTurnstileVerifier(config, transport)('dummy-token', '127.0.0.1', { action: 'login', cdata: 'dummy-does-not-return-cdata' })).toBe(true);
    expect(calls).toBe(1);
  });
  test('ausência/token excessivo não chama o transporte', async () => {
    let calls = 0;
    const verify = createTurnstileVerifier(config, async () => { calls++; return Response.json({}); });
    expect(await verify('')).toBe(false); expect(await verify('x'.repeat(2049))).toBe(false); expect(calls).toBe(0);
  });
  test.each(['invalid-input-response', 'timeout-or-duplicate', 'internal-error'])('bloqueia rejeição, expiração/reuso: %s', async code => {
    expect(await mockVerify({ success: false, 'error-codes': [code] }, config)('token')).toBe(false);
  });
  test('rede, JSON inválido, HTTP externo e timeout bloqueiam', async () => {
    const responses: SiteverifyFetch[] = [
      async () => { throw new Error('private upstream error'); },
      async () => new Response('{'), async () => new Response(null, { status: 503 }),
      async () => new Promise<Response>(() => {}),
    ];
    for (const transport of responses) expect(await createTurnstileVerifier({ ...config, turnstileTimeoutMs: 20 }, transport)('token')).toBe(false);
  });
  test('produção valida hostname/action/cdata e idade do desafio', async () => {
    expect(await mockVerify(approved())('token', undefined, { action: 'login', cdata: 'session-binding' })).toBe(true);
    for (const value of [
      { ...approved(), hostname: 'example.com' }, { ...approved(), action: 'register' }, { ...approved(), cdata: 'other-session' },
      { ...approved(), challenge_ts: new Date(Date.now()-301000).toISOString() },
      { ...approved(), challenge_ts: new Date(Date.now()+60000).toISOString() }, { ...approved(), challenge_ts: 'invalid' },
      { success: true, hostname: 'localhost' }, null, true,
    ]) expect(await mockVerify(value)('token', undefined, { action: 'login', cdata: 'session-binding' })).toBe(false);
  });
  test('modo dummy exige resposta example.com e nunca aprova em produção', async () => {
    expect(await mockVerify({ success: true, hostname: 'localhost' }, config)('token')).toBe(false);
    expect(await mockVerify({ success: true, hostname: 'example.com' }, { ...config, production: true })('token')).toBe(false);
  });
  test('reuso concorrente é bloqueado localmente antes da convergência de siteverify real', async () => {
    let calls = 0;
    const verify = createTurnstileVerifier(real, async()=>{calls++;return Response.json(approved());});
    const results = await Promise.all([verify('same-token'),verify('same-token')]);
    expect(results.sort()).toEqual([false,true]); expect(calls).toBe(1);
    expect(await verify('same-token')).toBe(false);
  });
});

describe('configuração segura', () => {
  test.each(['1', '2', '3'])('recusa secret dummy %s em produção', prefix => {
    expect(() => loadSecurityEnv({ ...environment, NODE_ENV: 'production', PUBLIC_HUB_URL: 'https://api.example.com', CLOUDFLARE_TURNSTILE_SECRET_KEY: `${prefix}x0000000000000000000000000000000AA` })).toThrow();
  });
  test('recusa HTTP remoto/produção, URL com caminho e endpoint arbitrário', () => {
    for (const values of [
      { PUBLIC_HUB_URL: 'http://example.com' }, { PUBLIC_HUB_URL: 'http://localhost/path' }, { NODE_ENV: 'production' },
      { CLOUDFLARE_TURNSTILE_VERIFY_URL: 'https://attacker.example/siteverify' }, { JWT_SECRET: 'too-short' },
      { AUTH_SESSION_TTL_SECONDS: '7200' }, { TRUSTED_PROXY_IPS: '*' }, { TRUSTED_PROXY_HEADER: 'x-client-ip' },
    ]) expect(() => loadSecurityEnv({ ...environment, ...values })).toThrow();
    expect(loadSecurityEnv({ ...environment, PUBLIC_HUB_URL: 'https://hub.example.com' }).publicHubUrl).toBe('https://hub.example.com');
  });
});

describe('limites de borda e proxy explícito', () => {
  test('10 autenticações/minuto e 500 ingestões/segundo em grupos separados', () => {
    let now = 0; const limiter = new EdgeRateLimiter(() => now);
    for (let i=0;i<10;i++) expect(limiter.consume('auth', '127.0.0.1').allowed).toBe(true);
    expect(limiter.consume('auth', '127.0.0.1')).toEqual({ allowed: false, retryAfter: 60 });
    for (let i=0;i<500;i++) expect(limiter.consume('ingestion', '127.0.0.1').allowed).toBe(true);
    expect(limiter.consume('ingestion', '127.0.0.1')).toEqual({ allowed: false, retryAfter: 1 });
    now=1000; expect(limiter.consume('ingestion', '127.0.0.1').allowed).toBe(true);
    expect(limiter.consume('auth', '127.0.0.1').allowed).toBe(false);
    expect(limiter.consume('auth', '192.0.2.2').allowed).toBe(true);
    now=60000; expect(limiter.consume('auth', '127.0.0.1').allowed).toBe(true);
  });
  test('saturação de memória não cria bypass de rate limit', () => {
    const limiter = new EdgeRateLimiter(() => 0, 1);
    expect(limiter.consume('auth','192.0.2.1').allowed).toBe(true);
    expect(limiter.consume('auth','192.0.2.2').allowed).toBe(false);
  });
  test('peer não confiável ignora XFF/CF; app.handle sem socket usa bucket conservador', () => {
    const request = new Request('http://localhost', { headers: { 'x-forwarded-for': '192.0.2.1', 'cf-connecting-ip': '192.0.2.2' } });
    expect(clientIp(request, '127.0.0.1', config)).toBe('127.0.0.1');
    expect(clientIp(request, undefined, config)).toBe('unknown');
    expect(clientIp(request, '::ffff:127.0.0.1', config)).toBe('127.0.0.1');
  });
  test('proxy confiável usa somente o header selecionado e valida a cadeia', () => {
    const proxied = { trustedProxyIps: ['127.0.0.1','10.0.0.1'], trustedProxyHeader: 'x-forwarded-for' } as const;
    const request = (value: string) => new Request('http://localhost', { headers: { 'x-forwarded-for': value } });
    expect(clientIp(request('192.0.2.99, 192.0.2.2, 10.0.0.1'), '127.0.0.1', proxied)).toBe('192.0.2.2');
    expect(clientIp(request('bad, 10.0.0.1'), '127.0.0.1', proxied)).toBe('127.0.0.1');
    const cloudflare = { ...proxied, trustedProxyHeader: 'cf-connecting-ip' } as const;
    expect(clientIp(new Request('http://localhost',{headers:{'cf-connecting-ip':'192.0.2.3'}}), '127.0.0.1', cloudflare)).toBe('192.0.2.3');
    expect(clientIp(new Request('http://localhost',{headers:{'cf-connecting-ip':'192.0.2.3, 192.0.2.4'}}), '127.0.0.1', cloudflare)).toBe('127.0.0.1');
  });
});
