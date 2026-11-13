import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { SignJWT } from 'jose';
import { and, eq, inArray } from 'drizzle-orm';
import {
  authSessions, connectionAuthorizations, connectionCredentials,
  connections, erpDestinations, erpDispatches, inventoryLedger,
  pipelineJobs, products, spokeMappings, users, workspaces,
} from '@omnihub/database';
import type { MeliTokens } from '@omnihub/marketplace-adapters';
import { createApp } from '../src/app';
import { loadSecurityEnv } from '../src/config/security';
import { validateTargetBindings, type ErpTargetBinding, type PipelineRuntime } from '../src/config/runtime';
import { CredentialCipher } from '../src/services/credential-cipher';
import { ConnectionCredentialStore, type ConnectionSettings } from '../src/services/connection-credentials';
import { ConnectionsService } from '../src/services/connections.service';
import { ConnectionRuntime } from '../src/services/connection-runtime';
import { AuthService } from '../src/plugins/auth';
import { createMockErp } from '../../mock-erp/src/app';
import { OperationsService } from '../src/services/operations.service';
import { databaseFixture, testDatabaseUrl } from './helpers';

const origin = 'http://localhost:5173';
const security = loadSecurityEnv({
  NODE_ENV: 'test',
  PUBLIC_HUB_URL: 'http://localhost',
  CORS_ORIGINS: origin,
  JWT_SECRET: 'qa-task014-jwt-secret-min-32-chars-long-super-secure',
  CLOUDFLARE_TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
});
const settings: ConnectionSettings = {
  clientId: '123456',
  clientSecret: 'qa-task014-test-app-secret',
  redirectUri: 'https://callback.example.invalid/api/oauth/meli/callback',
  publicHubUrl: 'http://localhost',
  returnUrl: `${origin}/connections`,
};
const keys = new Map([['v1', randomBytes(32)]]);
const cipher = new CredentialCipher('v1', keys);
const operator = 'qa-task014-operator-secret-token-32-chars-long';
const accountId = () => String(BigInt(`0x${Bun.randomUUIDv7().replaceAll('-', '')}`));

describe.skipIf(!testDatabaseUrl)('QA Independente TASK-014 — Auditoria e Aceite de Conexões e ERP', () => {
  const a = databaseFixture(), b = databaseFixture();
  const created = new Set<string>();
  const sessions = new Set<string>();
  const extraDestinations = new Set<string>();

  afterEach(async () => {
    if (created.size) await a.db.delete(connections).where(inArray(connections.id, [...created]));
    if (sessions.size) await a.db.delete(authSessions).where(inArray(authSessions.id, [...sessions]));
    if (extraDestinations.size) await a.db.delete(erpDestinations).where(inArray(erpDestinations.id, [...extraDestinations]));
    created.clear();
    sessions.clear();
    extraDestinations.clear();
  });

  async function login(f = a) {
    const now = Math.floor(Date.now() / 1000);
    const sid = Bun.randomUUIDv7();
    sessions.add(sid);
    await a.db.insert(authSessions).values({
      id: sid,
      userId: f.ownerId,
      issuedAt: new Date(now * 1000),
      expiresAt: new Date((now + 3600) * 1000),
    });
    const token = await new SignJWT({ sid })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(f.ownerId)
      .setIssuer(security.issuer)
      .setAudience(security.audience)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(new TextEncoder().encode(security.jwtSecret));
    const cookie = `omnihub_session=${token}`;
    const session = await new AuthService(a.db, security).authenticate(new Request('http://localhost', { headers: { cookie } }));
    return { cookie, session };
  }

  function transport(options: { failGrant?: boolean; wrongIdentity?: boolean; testUser?: boolean; site?: string } = {}) {
    const grants: string[] = [];
    const reads: string[] = [];
    const run = async (request: Request) => {
      expect(new URL(request.url).origin).toBe('https://api.mercadolibre.com');
      if (request.method === 'POST') {
        const form = new URLSearchParams(await request.text());
        const credential = form.get('code') ?? form.get('refresh_token')!;
        const user = credential.split(':')[1]!;
        grants.push(user);
        if (options.failGrant) throw new Error('synthetic grant network ambiguity');
        return Response.json({
          access_token: `access:${user}:new`,
          refresh_token: `refresh:${user}:new`,
          user_id: user,
          expires_in: 3600,
          token_type: 'bearer',
        });
      }
      const user = request.headers.get('authorization')!.split(':')[1]!;
      reads.push(user);
      expect(new URL(request.url).pathname).toBe('/users/me');
      return Response.json({
        id: options.wrongIdentity ? '999' : user,
        site_id: options.site ?? 'MLB',
        tags: options.testUser === false ? [] : ['test_user'],
      });
    };
    return { run, grants, reads };
  }

  function targetFor(f = a): ErpTargetBinding {
    const erp = createMockErp({
      adminToken: operator,
      webhookSecret: 'qa-task014-isolated-webhook-secret-32-chars',
      hubWebhookUrl: 'http://127.0.0.1:1/not-used',
      chaos: { minMs: 0, maxMs: 0, failureRate: 0 },
    });
    return {
      ...f.workerContext,
      url: f.erpUrl,
      configKey: f.configKey,
      adminToken: operator,
      webhookSecret: 'qa-task014-isolated-webhook-secret-32-chars',
      transport: r => erp.handle(r),
      sleep: async () => {},
    };
  }

  function setup(t = transport(), targets?: ErpTargetBinding[]) {
    const store = new ConnectionCredentialStore(a.db, cipher, { ...settings, transport: t.run });
    const service = new ConnectionsService(a.db, store);
    const pipelines: NonNullable<PipelineRuntime['pipelines']>[number][] = [];
    const manager = new ConnectionRuntime(a.db, service, pipelines, targets ?? []);
    const runtime: PipelineRuntime = {
      adminToken: operator,
      webhookSecret: '',
      erpUrl: '',
      mockAdminToken: '',
      pipelines,
      erpTargets: targets ?? [],
      connectionRuntime: manager,
    };
    let challenges = 0;
    const app = createApp({
      db: a.db,
      security,
      runtime,
      corsOrigins: [origin],
      siteverifyFetch: async () => {
        challenges++;
        return Response.json({ success: true, hostname: 'example.com' });
      },
    });
    const request = (
      path: string,
      auth?: Awaited<ReturnType<typeof login>>,
      body?: unknown,
      headers: Record<string, string> = {},
      method = body ? 'POST' : 'GET',
    ) => app.handle(new Request(`http://localhost${path}`, {
      method,
      headers: {
        ...(auth ? { cookie: auth.cookie } : {}),
        ...(method === 'POST' ? { origin, 'x-csrf-token': auth?.session.account.csrfToken ?? '', 'x-turnstile-token': 'qa-synthetic-turnstile' } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    return { store, service, manager, runtime, app, request, t, get challenges() { return challenges; } };
  }

  async function create(h: ReturnType<typeof setup>, f = a, mode: 'OFFICIAL_TEST_USER' | 'LOCAL_FIXTURE' = 'OFFICIAL_TEST_USER') {
    const row = await h.service.create(f.context, { name: 'QA shop', platform: 'MERCADO_LIVRE', transportMode: mode });
    created.add(row.id);
    return row;
  }

  async function pending(h: ReturnType<typeof setup>, auth: Awaited<ReturnType<typeof login>>, id: string, user = accountId()) {
    const start = await h.service.start(auth.session, id);
    const url = new URL(settings.redirectUri);
    url.search = new URLSearchParams({
      state: new URL(start.authorizationUrl).searchParams.get('state')!,
      code: `code:${user}:qa-synthetic`,
    }).toString();
    await h.service.callback(url.toString());
    return { ...start, user, url };
  }

  async function activate(h: ReturnType<typeof setup>, id: string, user = accountId(), expired = false, f = a) {
    const tokens: MeliTokens = {
      accessToken: `access:${user}:initial`,
      refreshToken: `refresh:${user}:initial`,
      userId: user,
      expiresAt: Date.now() + (expired ? -1000 : 3600000),
    };
    await a.db.update(connections).set({ state: 'ACTIVE', credentialState: 'CONNECTED', externalAccountId: user }).where(eq(connections.id, id));
    await a.db.insert(connectionCredentials).values({
      workspaceId: f.context.workspaceId,
      connectionId: id,
      appId: settings.clientId,
      envelope: cipher.seal(tokens, h.store.scope(f.context.workspaceId, id)),
    });
    return tokens;
  }

  test('[QA-014-01] Sessão vs Operador: operador rejeitado com 401 e validação estrita impede mass assignment', async () => {
    const h = setup(), auth = await login();
    // 1. Operator Bearer token cannot bypass user session on connections or erp-destinations
    const opHeaders = { authorization: `Bearer ${operator}`, 'x-workspace-id': a.context.workspaceId };
    expect((await h.request('/api/v1/connections', undefined, undefined, opHeaders)).status).toBe(401);
    expect((await h.request('/api/v1/erp-destinations', undefined, undefined, opHeaders)).status).toBe(401);

    // 2. Mass assignment / extra fields rejected with 422
    const bodyExtra = { name: 'Store', platform: 'MERCADO_LIVRE', transportMode: 'OFFICIAL_TEST_USER', workspaceId: b.context.workspaceId };
    const resExtra = await h.request('/api/v1/connections', auth, bodyExtra);
    expect(resExtra.status).toBe(422);

    // 3. Valid creation returns 201 with safe metadata (no tokens/envelope)
    const validBody = { name: 'Valid Store', platform: 'MERCADO_LIVRE', transportMode: 'OFFICIAL_TEST_USER' };
    const res = await h.request('/api/v1/connections', auth, validBody);
    expect(res.status).toBe(201);
    const row = await res.json() as { id: string; status: string; state: string };
    created.add(row.id);
    expect(row.state).toBe('DISABLED');
    expect(row.status).toBe('NOT_CONNECTED');
  });

  test('[QA-014-02] IDOR e fronteiras de Workspace: impossível interagir com conexão estrangeira', async () => {
    const h = setup(), authA = await login(a), authB = await login(b);
    const connA = await create(h, a);

    // Workspace B attempting any action on Conn A must fail (404)
    expect((await h.request(`/api/v1/connections/${connA.id}/oauth/start`, authB, {})).status).toBe(404);
    expect((await h.request(`/api/v1/connections/${connA.id}/oauth`, authB)).status).toBe(404);
    expect((await h.request(`/api/v1/connections/${connA.id}/check`, authB, {})).status).toBe(404);
    expect((await h.request(`/api/v1/connections/${connA.id}/disable`, authB, {})).status).toBe(404);
    expect((await h.request(`/api/v1/connections/${connA.id}/simulate`, authB, { scenario: 'PAID' })).status).toBe(404);
  });

  test('[QA-014-03] Confirmação OAuth: vínculo estrito à sessão iniciadora e sanitização de URL de retorno', async () => {
    const h = setup(), auth1 = await login(), auth2 = await login(), conn = await create(h);
    const start = await h.service.start(auth1.session, conn.id);
    const url = new URL(settings.redirectUri);
    const user = accountId();
    url.search = new URLSearchParams({
      state: new URL(start.authorizationUrl).searchParams.get('state')!,
      code: `code:${user}:qa-synthetic`,
    }).toString();

    // 1. Cross-host callback: returns 303 Redirect to fixed returnUrl WITHOUT any query or fragment code/state/token
    const callbackResp = await h.app.handle(new Request(url.toString()));
    expect(callbackResp.status).toBe(303);
    const loc = callbackResp.headers.get('location');
    expect(loc).toBe(settings.returnUrl);
    expect(loc).not.toContain('code');
    expect(loc).not.toContain('state');
    expect(loc).not.toContain('token');

    // 2. Connection remains DISABLED until confirmed
    const unconfirmed = await h.service.get(a.context, conn.id);
    expect(unconfirmed.state).toBe('DISABLED');

    // 3. Different session of the same user cannot confirm (OAUTH_STATE_INVALID)
    await expect(h.service.confirm(auth2.session, conn.id, start.attemptId)).rejects.toMatchObject({ code: 'OAUTH_STATE_INVALID' });

    // 4. Initiating session confirms successfully
    const confirmed = await h.service.confirm(auth1.session, conn.id, start.attemptId);
    expect(confirmed.status).toBe('CONNECTED');
    expect(confirmed.state).toBe('ACTIVE');

    // 5. Replay fails closed
    await expect(h.service.confirm(auth1.session, conn.id, start.attemptId)).rejects.toMatchObject({ code: 'OAUTH_STATE_INVALID' });
  });

  test('[QA-014-04] Criptografia de credenciais: AAD de workspace/conexão/app/finalidade e integridade GCM', () => {
    const scope1 = { workspaceId: 'w1', connectionId: 'c1', appId: 'app1', purpose: 'tokens' };
    const envelope = cipher.seal({ test: 'secret' }, scope1);

    // Tampered payload fails closed
    const tampered = JSON.parse(envelope) as Record<string, unknown>;
    tampered.ciphertext = 'bad-ciphertext';
    expect(() => cipher.open(JSON.stringify(tampered), scope1)).toThrow();

    // Swapped context fails closed
    const scope2 = { ...scope1, workspaceId: 'w2' };
    expect(() => cipher.open(envelope, scope2)).toThrow();
    const scope3 = { ...scope1, connectionId: 'c2' };
    expect(() => cipher.open(envelope, scope3)).toThrow();
    const scope4 = { ...scope1, purpose: 'pending' };
    expect(() => cipher.open(envelope, scope4)).toThrow();

    // Key rotation: keyring with { v1, v2 } decrypts v1 envelope; new envelope uses activeVersion v2
    const rotated = new CredentialCipher('v2', new Map([...keys, ['v2', randomBytes(32)]]));
    expect(rotated.open(envelope, scope1)).toEqual({ test: 'secret' });
    const newEnv = rotated.seal({ test: 'v2-secret' }, scope1);
    expect(JSON.parse(newEnv).version).toBe('v2');
  });

  test('[QA-014-05] Gestão de refresh: falha de rotação exige REAUTH_REQUIRED e não repete POST ambíguo', async () => {
    const t = transport({ failGrant: true });
    const h = setup(t), conn = await create(h), user = accountId();
    await activate(h, conn.id, user, true); // Expired token triggers refresh

    // Refresh throws network ambiguity
    await expect(h.store.use(a.context, conn.id, c => c.getCurrentUser())).rejects.toBeDefined();
    // Subsequent read fails with REAUTH_REQUIRED without retrying POST
    await expect(h.store.use(a.context, conn.id, c => c.getCurrentUser())).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' });
    expect(t.grants).toHaveLength(1); // Exactly 1 POST was attempted, NO ambiguous retry

    // Connection credentialState is now REAUTH_REQUIRED
    const current = await h.service.get(a.context, conn.id);
    expect(current.credentialState).toBe('REAUTH_REQUIRED');

    // Reconnecting recovers the same account
    const recovered = setup();
    const auth = await login();
    const p = await pending(recovered, auth, conn.id, user);
    const recRes = await recovered.service.confirm(auth.session, conn.id, p.attemptId);
    expect(recRes.status).toBe('CONNECTED');
  });

  test('[QA-014-06] Reautorização com conta diferente falha closed para preservar histórico', async () => {
    const h = setup(), auth = await login(), conn = await create(h), originalUser = accountId();
    await activate(h, conn.id, originalUser);

    // Attempting to reconnect the store with a DIFFERENT user ID fails during callback (ADAPTER_RESOURCE_MISMATCH)
    const intruder = accountId();
    await expect(pending(h, auth, conn.id, intruder)).rejects.toMatchObject({
      code: 'ADAPTER_RESOURCE_MISMATCH',
    });

    // Original externalAccountId is untouched
    const after = await h.service.get(a.context, conn.id);
    expect(after.externalAccountId).toBe(originalUser);
  });

  test('[QA-014-07] ERP Destination: operador pré-configurado, um ativo por negócio e bloqueio com trabalhos pendentes', async () => {
    const t1 = targetFor(a);
    const secondId = Bun.randomUUIDv7();
    extraDestinations.add(secondId);
    await a.db.insert(erpDestinations).values({
      id: secondId,
      workspaceId: a.context.workspaceId,
      configKey: `second-erp-${secondId}`,
      endpointOrigin: 'http://127.0.0.1:34991',
      state: 'DISABLED',
    });
    const t2: ErpTargetBinding = {
      ...t1,
      erpDestinationId: secondId,
      configKey: `second-erp-${secondId}`,
      url: 'http://127.0.0.1:34991',
      webhookSecret: 'qa-task014-second-secret-32-chars-length',
    };
    validateTargetBindings([t1, t2]);
    const h = setup(transport(), [t1, t2]), auth = await login(a);

    // List returns allowed destinations without secrets
    const listRes = await h.request('/api/v1/erp-destinations', auth);
    expect(listRes.status).toBe(200);
    const erpList = await listRes.json() as { data: { id: string; name: string; state: string }[] };
    expect(erpList.data.map(d => d.id).sort()).toEqual([t1.erpDestinationId, secondId].sort());

    // Selecting second destination activates it and disables the first
    const selectRes = await h.request('/api/v1/erp-destinations/select', auth, { destinationId: secondId });
    expect(selectRes.status).toBe(200);
    const updatedList = await selectRes.json() as { data: { id: string; state: string }[] };
    expect(updatedList.data.find(d => d.id === secondId)!.state).toBe('ACTIVE');
    expect(updatedList.data.find(d => d.id === t1.erpDestinationId)!.state).toBe('DISABLED');

    // Queue a job to test switch locking
    const conn = await create(h, a, 'LOCAL_FIXTURE');
    const simRes = await h.request(`/api/v1/connections/${conn.id}/simulate`, auth, { scenario: 'PAID' });
    expect(simRes.status).toBe(200);
    const simJob = await simRes.json() as { processingId: string };
    a.trackProcessing(simJob.processingId);

    // Switching back while job is QUEUED is blocked with 409 ERP_WORK_IN_PROGRESS
    const switchBlocked = await h.request('/api/v1/erp-destinations/select', auth, { destinationId: t1.erpDestinationId });
    expect(switchBlocked.status).toBe(409);

    // Clean up job to leave database consistent
    await a.db.delete(pipelineJobs).where(eq(pipelineJobs.id, simJob.processingId));
  });

  test('[QA-014-08] Canais não implementados (Amazon/Shopee) retornam NOT_IMPLEMENTED', async () => {
    const h = setup(), auth = await login();

    // 1. Create Amazon connection
    const resAmz = await h.request('/api/v1/connections', auth, { name: 'Amazon Store', platform: 'AMAZON', transportMode: 'OFFICIAL_TEST_USER' });
    expect(resAmz.status).toBe(201);
    const amz = await resAmz.json() as { id: string; status: string; state: string };
    created.add(amz.id);
    expect(amz.status).toBe('NOT_IMPLEMENTED');
    expect(amz.state).toBe('DISABLED');

    // 2. Starting OAuth or Check on Amazon returns 501 NOT_IMPLEMENTED
    expect((await h.request(`/api/v1/connections/${amz.id}/oauth/start`, auth, {})).status).toBe(501);
    expect((await h.request(`/api/v1/connections/${amz.id}/check`, auth, {})).status).toBe(501);
  });
});
