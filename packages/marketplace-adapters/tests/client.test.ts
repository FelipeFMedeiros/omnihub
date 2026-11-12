import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { AdapterError, createMeliAuthorization, MeliClient, validateMeliCallback, validateRedirectUri, type AdapterErrorCode, type MeliClientOptions, type MeliTokens } from '../src';
import enriched from './fixtures/meli-order-enriched.json';

const now = 1_800_000_000_000;
const identity = { id: 900000001, site_id: 'MLB', tags: ['test_user'] };
const tokens: MeliTokens = { accessToken: 'fake-access', refreshToken: 'fake-refresh', userId: '900000001', expiresAt: now + 3600_000 };
const grant = { access_token: 'fake-new-access', refresh_token: 'fake-new-refresh', user_id: 900000001, expires_in: 21600, token_type: 'Bearer' };
const defaults = { clientId: '123456', clientSecret: 'fake-client-secret', expectedSellerId: '900000001', now: () => now, initialTokens: tokens, random: () => 0, sleep: async () => {} } satisfies MeliClientOptions;
function json(value: unknown, status = 200, headers?: Record<string, string>) { return new Response(JSON.stringify(value), { status, headers }); }
async function rejected(promise: Promise<unknown>, code: AdapterErrorCode) {
  try { await promise; throw new Error('Era esperada uma rejeição.'); }
  catch (error) { expect(error).toBeInstanceOf(AdapterError); expect((error as AdapterError).code).toBe(code); return error as AdapterError; }
}
const auth = () => createMeliAuthorization({ clientId: defaults.clientId, redirectUri: 'https://callback.example.invalid/oauth?flow=meli', now });
function callback(attempt: ReturnType<typeof auth>['attempt']) {
  const url = new URL(attempt.redirectUri); url.searchParams.set('code', 'fake-code'); url.searchParams.set('state', attempt.state); return url;
}

describe('OAuth Mercado Livre', () => {
  test('gera state único e PKCE S256 sem enviar o verifier na URL', () => {
    const a = auth(), b = auth(); const url = new URL(a.url);
    expect(a.attempt.state).not.toBe(b.attempt.state);
    expect(url.origin).toBe('https://auth.mercadolivre.com.br');
    expect(url.searchParams.get('redirect_uri')).toBe(a.attempt.redirectUri);
    expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(a.attempt.codeVerifier!).digest('base64url'));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(a.url).not.toContain(a.attempt.codeVerifier!);
    expect(validateMeliCallback(callback(a.attempt).toString(), a.attempt, now)).toBe('fake-code');
  });
  test('permite desabilitar PKCE conforme configuração da aplicação', () => {
    const result = createMeliAuthorization({ clientId: '123456', redirectUri: 'http://127.0.0.1:3001/callback', pkce: false, now });
    expect(result.attempt.codeVerifier).toBeUndefined();
    expect(new URL(result.url).searchParams.has('code_challenge')).toBe(false);
  });
  test.each(['http://external.example.invalid/callback', 'https://u:p@example.invalid', 'https://example.invalid/#fragment', 'https://example.invalid/?state=x', 'invalid'])('rejeita redirect inseguro %s', redirect => {
    expect(() => validateRedirectUri(redirect)).toThrow(AdapterError);
  });
  test('recusa state, redirect, query registrada, duplicação, erro e expiração', () => {
    const { attempt } = auth(); const valid = callback(attempt);
    const badState = new URL(valid); badState.searchParams.set('state', 'x');
    const duplicate = new URL(valid); duplicate.searchParams.append('state', attempt.state);
    const duplicateCode = new URL(valid); duplicateCode.searchParams.append('code', 'other');
    const error = new URL(valid); error.searchParams.set('error', 'access_denied');
    const query = new URL(valid); query.searchParams.set('flow', 'changed');
    const foreign = new URL(valid); foreign.hostname = 'other.example.invalid';
    const path = new URL(valid); path.pathname = '/other';
    for (const invalid of [badState, duplicate, duplicateCode, error, query, foreign, path]) {
      expect(() => validateMeliCallback(invalid.toString(), attempt, now)).toThrow(AdapterError);
    }
    expect(() => validateMeliCallback(valid.toString(), attempt, attempt.expiresAt)).toThrow(AdapterError);
  });
  test('valida callback antes de qualquer HTTP e troca código sem reenvio automático', async () => {
    let calls = 0; const { attempt } = auth();
    const client = new MeliClient({ ...defaults, transport: async request => {
      calls++; expect(request.url).toBe('https://api.mercadolibre.com/oauth/token');
      expect(request.method).toBe('POST'); expect(request.redirect).toBe('error');
      const form = new URLSearchParams(await request.text());
      expect(form.get('code')).toBe('fake-code'); expect(form.get('code_verifier')).toBe(attempt.codeVerifier!);
      expect(form.get('redirect_uri')).toBe(attempt.redirectUri); expect(form.get('client_secret')).toBe(defaults.clientSecret);
      return json({ ...grant, token_type: 'bearer' });
    } });
    await rejected(client.exchangeAuthorizationCode('https://callback.example.invalid/?state=bad&code=x', attempt), 'MELI_OAUTH_CALLBACK_REJECTED');
    expect(calls).toBe(0);
    expect((await client.exchangeAuthorizationCode(callback(attempt).toString(), attempt)).refreshToken).toBe(grant.refresh_token);
    expect(calls).toBe(1);
  });
});

describe('cliente de leitura com transporte simulado', () => {
  test('obtém identidade e esconde credenciais da serialização', async () => {
    const client = new MeliClient({ ...defaults, transport: async request => {
      expect(request.url).toBe('https://api.mercadolibre.com/users/me');
      expect(request.headers.get('Authorization')).toBe('Bearer fake-access'); return json(identity);
    } });
    expect(await client.getCurrentUser()).toEqual({ id: '900000001', siteId: 'MLB', isTestUser: true });
    expect(JSON.stringify(client)).toBe('{}');
  });
  test('compartilha refresh concorrente e persiste rotação antes de usar token', async () => {
    let refreshes = 0, persisted = false, reads = 0;
    const client = new MeliClient({ ...defaults, initialTokens: undefined, refreshToken: 'fake-refresh',
      onTokens: async saved => { expect(saved.refreshToken).toBe(grant.refresh_token); persisted = true; },
      transport: async request => {
        if (request.method === 'POST') { refreshes++; expect(new URLSearchParams(await request.text()).get('refresh_token')).toBe('fake-refresh'); return json(grant); }
        reads++; expect(persisted).toBe(true); expect(request.headers.get('Authorization')).toBe('Bearer fake-new-access'); return json(identity);
      },
    });
    await Promise.all([client.getCurrentUser(), client.getCurrentUser()]);
    expect(refreshes).toBe(1); expect(reads).toBe(2);
  });
  test('401 renova uma vez e reutiliza o refresh rotacionado', async () => {
    const refreshes: string[] = []; let oldFailed = false, newFailed = false;
    const client = new MeliClient({ ...defaults, transport: async request => {
      if (request.method === 'POST') {
        refreshes.push(new URLSearchParams(await request.text()).get('refresh_token')!);
        return json(refreshes.length === 1 ? grant : { ...grant, access_token: 'fake-third-access', refresh_token: 'fake-third-refresh' });
      }
      if (!oldFailed) { oldFailed = true; return json({}, 401); }
      if (refreshes.length === 1 && newFailed) return json({}, 401);
      if (refreshes.length === 1) newFailed = true;
      return json(identity);
    } });
    await client.getCurrentUser(); await client.getCurrentUser();
    expect(refreshes).toEqual(['fake-refresh', 'fake-new-refresh']);
  });
  test('refresh no limiar de expiração e não entra em loop de 401', async () => {
    let grants = 0, gets = 0;
    const client = new MeliClient({ ...defaults, initialTokens: { ...tokens, expiresAt: now + 1000 }, transport: async request => {
      if (request.method === 'POST') { grants++; return json(grant); } gets++; return json({}, 401);
    } });
    await rejected(client.getCurrentUser(), 'MELI_HTTP_ERROR');
    expect(grants).toBe(2); expect(gets).toBe(2);
  });
  test('falha de persistência impede leitura com o token novo', async () => {
    let reads = 0;
    const client = new MeliClient({ ...defaults, initialTokens: undefined, refreshToken: 'fake-refresh',
      onTokens: async () => { throw new Error('fake-secret-inside-cause'); }, transport: async request => {
        if (request.method !== 'POST') reads++; return json(grant);
      },
    });
    const error = await rejected(client.getCurrentUser(), 'MELI_TOKEN_PERSISTENCE_FAILED');
    expect(reads).toBe(0); expect(JSON.stringify(error)).not.toContain('fake-secret');
  });
  test('GET aplica backoff limitado e respeita Retry-After', async () => {
    let calls = 0; const waits: number[] = [];
    const client = new MeliClient({ ...defaults, sleep: async ms => { waits.push(ms); }, transport: async () => {
      calls++; return calls === 1 ? json({}, 503) : calls === 2 ? json({}, 429, { 'Retry-After': '2' }) : json(identity);
    } });
    await client.getCurrentUser(); expect(calls).toBe(3); expect(waits).toEqual([200, 2000]);
  });
  test('não retenta cedo quando Retry-After excede orçamento', async () => {
    let calls = 0; const waits: number[] = [];
    const client = new MeliClient({ ...defaults, sleep: async ms => { waits.push(ms); }, transport: async () => { calls++; return json({}, 429, { 'Retry-After': '60' }); } });
    expect((await rejected(client.getCurrentUser(), 'MELI_HTTP_ERROR')).status).toBe(429);
    expect(calls).toBe(1); expect(waits).toEqual([]);
  });
  test('rede indisponível: três GETs, sem vazar causa sensível', async () => {
    let calls = 0;
    const client = new MeliClient({ ...defaults, transport: async () => { calls++; throw new Error('fake-secret-in-url'); } });
    const error = await rejected(client.getCurrentUser(), 'MELI_NETWORK_ERROR');
    expect(calls).toBe(3); expect(error.message).not.toContain('fake-secret');
  });
  test('timeout aborta cada tentativa', async () => {
    let aborted = 0;
    const client = new MeliClient({ ...defaults, timeoutMs: 5, transport: async request => new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener('abort', () => { aborted++; reject(new Error('aborted')); }, { once: true });
    }) });
    await rejected(client.getCurrentUser(), 'MELI_NETWORK_ERROR'); expect(aborted).toBe(3);
  });
  test.each([503, 429])('POST de refresh não é repetido no status %s', async status => {
    let calls = 0;
    const client = new MeliClient({ ...defaults, initialTokens: undefined, refreshToken: 'fake-refresh', transport: async () => { calls++; return json({ secret: 'fake-secret-body' }, status); } });
    const error = await rejected(client.getCurrentUser(), 'MELI_HTTP_ERROR');
    expect(calls).toBe(1); expect(error.message).not.toContain('fake-secret');
  });
  test.each(['invalid', '{}', JSON.stringify({ ...identity, id: Number.MAX_SAFE_INTEGER + 1 }), 'x'.repeat(2 * 1024 * 1024 + 1)])('rejeita resposta inválida ou excessiva', async body => {
    const client = new MeliClient({ ...defaults, transport: async () => new Response(body) });
    await rejected(client.getCurrentUser(), 'MELI_INVALID_RESPONSE');
  });
  test('recusa credencial de outro vendedor e resposta de pedido trocado', async () => {
    expect(() => new MeliClient({ ...defaults, initialTokens: { ...tokens, userId: '900000003' } })).toThrow(AdapterError);
    const client = new MeliClient({ ...defaults, transport: async () => json({ ...enriched.order, seller: { id: 900000003 } }) });
    await rejected(client.getOrder(enriched.order.id), 'ADAPTER_RESOURCE_MISMATCH');
  });
  test('lê recursos relacionados pelo host fixo e com formato novo de envio', async () => {
    const paths: string[] = [];
    const client = new MeliClient({ ...defaults, transport: async request => {
      const url = new URL(request.url); expect(url.origin).toBe('https://api.mercadolibre.com'); paths.push(url.pathname);
      if (url.pathname.startsWith('/shipments/')) { expect(request.headers.get('x-format-new')).toBe('true'); return json(enriched.shipment); }
      if (url.pathname.startsWith('/orders/billing-info/')) return json(enriched.billingInfo);
      return json(enriched.order);
    } });
    const result = await client.loadOrderInput(enriched.order.id);
    expect(result.order).toEqual(enriched.order); expect(result.shipment).toEqual(enriched.shipment);
    expect(paths).toEqual(['/orders/2000000000000002', '/shipments/800000001', '/orders/billing-info/MLB/700000001']);
  });
  test('rejeita enriquecimento de outro comprador', async () => {
    const client = new MeliClient({ ...defaults, transport: async request => {
      const path = new URL(request.url).pathname;
      if (path.startsWith('/shipments/')) return json({ ...enriched.shipment, destination: { ...enriched.shipment.destination, receiver_id: 900000003 } });
      if (path.startsWith('/orders/billing-info/')) return json(enriched.billingInfo);
      return json(enriched.order);
    } });
    await rejected(client.loadOrderInput(enriched.order.id), 'ADAPTER_RESOURCE_MISMATCH');
  });
  test('rejeita URL arbitrária e notificação de outro app antes do HTTP', async () => {
    let calls = 0; const client = new MeliClient({ ...defaults, transport: async () => { calls++; return json({}); } });
    await rejected(client.getOrder('https://example.invalid'), 'ADAPTER_INVALID_PAYLOAD');
    await rejected(client.loadOrderNotification({ topic: 'orders_v2', resource: '/orders/123', user_id: 900000001, application_id: 123457 }), 'ADAPTER_RESOURCE_MISMATCH');
    expect(calls).toBe(0);
  });
});
