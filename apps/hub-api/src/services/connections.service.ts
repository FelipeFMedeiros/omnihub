import { createHash } from 'node:crypto';
import { authSessions, connectionAuthorizations as attempts, connectionCredentials as credentials, connections, workspaces, type Channel, type Database, type TransportMode } from '@omnihub/database';
import { createMeliAuthorization, MeliClient, validateMeliCallback, type MeliAuthorizationAttempt, type MeliTokens } from '@omnihub/marketplace-adapters';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { HubError } from '../errors';
import type { AuthenticatedSession } from '../plugins/auth';
import { ConnectionCredentialStore } from './connection-credentials';
import { sqlState } from './transaction';
import type { WorkspaceContext } from './context';
import { isLoopback } from '../config/security';

const invalid = () => new HubError(400, 'OAUTH_STATE_INVALID', 'Tentativa OAuth inválida, consumida ou expirada.');
const conflict = () => new HubError(409, 'CONNECTION_AUTHORIZATION_CONFLICT', 'Autorização incompatível ou conta já vinculada.');
type Connection = typeof connections.$inferSelect;
export function safeConnection(row: Connection) {
  const status = row.platform !== 'MERCADO_LIVRE' ? 'NOT_IMPLEMENTED' : row.credentialState === 'NOT_CONNECTED' ? 'NOT_CONNECTED' : row.state === 'DISABLED' ? 'DISABLED' : row.credentialState;
  return { id: row.id, name: row.name, platform: row.platform, transportMode: row.transportMode, state: row.state, status,
    createdAt: row.createdAt.toISOString(), checkedAt: row.checkedAt?.toISOString() ?? null, checkStatus: row.checkStatus, latencyMs: row.checkLatencyMs };
}
export class ConnectionsService {
  constructor(readonly db: Database, readonly store?: ConnectionCredentialStore) {}
  async get(context: WorkspaceContext, id: string) {
    const [row] = await this.db.select().from(connections).where(and(eq(connections.workspaceId, context.workspaceId), eq(connections.id, id)));
    if (!row) throw new HubError(404, 'CONNECTION_NOT_FOUND', 'Conexão não encontrada.');
    return row;
  }
  async list(context: WorkspaceContext) { return { data: (await this.db.select().from(connections).where(eq(connections.workspaceId, context.workspaceId)).orderBy(connections.createdAt, connections.id)).map(safeConnection) }; }
  async create(context: WorkspaceContext, input: { name: string; platform: Channel; transportMode: TransportMode }) {
    if (!input.name.trim()) throw new HubError(422, 'INVALID_CONNECTION_NAME', 'Informe um nome.');
    const id = Bun.randomUUIDv7(), local = input.platform === 'MERCADO_LIVRE' && input.transportMode === 'LOCAL_FIXTURE';
    const [row] = await this.db.insert(connections).values({ ...context, ...input, id, name: input.name.trim(),
      ...(local ? { externalAccountId: `local:${id}`, state: 'ACTIVE' as const, credentialState: 'CONNECTED' as const } : {}) }).returning();
    return safeConnection(row!);
  }
  private configured() { if (!this.store) throw new HubError(503, 'MELI_NOT_CONFIGURED', 'Configure as chaves e a aplicação no servidor.'); return this.store; }
  private implemented(row: Connection) { if (row.platform !== 'MERCADO_LIVRE') throw new HubError(501, 'NOT_IMPLEMENTED', 'Canal ainda não implementado.'); }
  private async activeSession(session: AuthenticatedSession) {
    const [row] = await this.db.select({ id: authSessions.id }).from(authSessions).innerJoin(workspaces, eq(workspaces.ownerId, authSessions.userId)).where(and(
      eq(authSessions.id, session.id), eq(authSessions.userId, session.account.user.id), eq(workspaces.id, session.account.workspace.id), isNull(authSessions.revokedAt), gt(authSessions.expiresAt, new Date())));
    if (!row) throw new HubError(401, 'UNAUTHENTICATED', 'Sessão iniciadora indisponível.');
  }
  async start(session: AuthenticatedSession, id: string) {
    const context = { workspaceId: session.account.workspace.id };
    const row = await this.get(context, id); this.implemented(row);
    if (row.transportMode !== 'OFFICIAL_TEST_USER') throw new HubError(409, 'LOCAL_CONNECTION_NO_OAUTH', 'Conexão local não utiliza OAuth.');
    const store = this.configured();
    await this.activeSession(session);
    const { attempt, url } = createMeliAuthorization({ clientId: store.settings.clientId, redirectUri: store.settings.redirectUri, pkce: true });
    const attemptId = Bun.randomUUIDv7();
    await this.db.transaction(async tx => {
      const [current] = await tx.select().from(connections).where(and(eq(connections.id, id), eq(connections.workspaceId, context.workspaceId))).for('update');
      if (!current) throw conflict();
      const generation = current.generation + 1;
      await tx.update(connections).set({ generation, state: 'DISABLED', credentialState: 'NOT_CONNECTED', checkedAt: null, checkStatus: null, checkLatencyMs: null }).where(eq(connections.id, id));
      await tx.delete(credentials).where(eq(credentials.connectionId, id));
      await tx.update(attempts).set({ status: 'FAILED', envelope: null }).where(and(eq(attempts.connectionId, id), sql`${attempts.status} <> 'CONFIRMED'`));
      await tx.insert(attempts).values({ id: attemptId, ...context, connectionId: id, userId: session.account.user.id, sessionId: session.id, generation,
        stateHash: createHash('sha256').update(attempt.state).digest('hex'), expiresAt: new Date(attempt.expiresAt),
        envelope: store.cipher.seal(attempt, store.scope(context.workspaceId, id, `authorization:${attemptId}`)) });
    });
    return { attemptId, authorizationUrl: url, expiresAt: new Date(attempt.expiresAt).toISOString() };
  }
  async poll(session: AuthenticatedSession, id: string) {
    await this.get({ workspaceId: session.account.workspace.id }, id);
    const [row] = await this.db.select({ attemptId: attempts.id, status: attempts.status, expiresAt: attempts.expiresAt }).from(attempts).where(and(
      eq(attempts.connectionId, id), eq(attempts.workspaceId, session.account.workspace.id), eq(attempts.sessionId, session.id), eq(attempts.userId, session.account.user.id))).orderBy(desc(attempts.createdAt), desc(attempts.id)).limit(1);
    return { attempt: row ? { ...row, status: row.expiresAt.getTime() <= Date.now() && row.status !== 'CONFIRMED' ? 'EXPIRED' : row.status, expiresAt: row.expiresAt.toISOString() } : null };
  }
  async callback(requestUrl: string) {
    const store = this.configured(), incoming = new URL(requestUrl), expected = new URL(store.settings.redirectUri);
    // The trusted static upstream is allowed for the existing HTTPS tunnel; never trust forwarded headers.
    const hub = new URL(store.settings.publicHubUrl), origins = [expected.origin, hub.origin];
    // cloudflared can preserve the registered Host on its HTTP loopback upstream.
    // This is a pinned server-configured host, never an incoming forwarded header.
    if (hub.protocol === 'http:' && isLoopback(hub.hostname)) origins.push(`http://${expected.host}`);
    if (!origins.includes(incoming.origin) || incoming.pathname !== expected.pathname) throw invalid();
    const states = incoming.searchParams.getAll('state');
    if (states.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(states[0]!)) throw invalid();
    const hash = createHash('sha256').update(states[0]!).digest('hex');
    const [row] = await this.db.select().from(attempts).where(eq(attempts.stateHash, hash));
    if (!row?.envelope || row.status !== 'STARTED' || row.expiresAt.getTime() <= Date.now()) throw invalid();
    const session: AuthenticatedSession = { id: row.sessionId, account: { user: { id: row.userId, name: '', email: '' }, workspace: { id: row.workspaceId, name: '' }, csrfToken: '', expiresAt: row.expiresAt.toISOString() } };
    await this.activeSession(session);
    const attempt = store.cipher.open(row.envelope, store.scope(row.workspaceId, row.connectionId, `authorization:${row.id}`)) as MeliAuthorizationAttempt;
    const canonical = new URL(expected); canonical.search = incoming.search;
    validateMeliCallback(canonical.toString(), attempt);
    const claimed = await this.db.update(attempts).set({ status: 'EXCHANGING', envelope: null }).where(and(eq(attempts.id, row.id), eq(attempts.status, 'STARTED'), gt(attempts.expiresAt, new Date()))).returning();
    if (!claimed.length) throw invalid();
    try {
      const current = await this.get(row, row.connectionId);
      if (current.generation !== row.generation) throw conflict();
      let tokens: MeliTokens | undefined;
      const assertAttempt = async () => {
        await this.activeSession(session);
        const [active] = await this.db.select({ id: attempts.id }).from(attempts).innerJoin(connections, and(eq(connections.id, attempts.connectionId), eq(connections.workspaceId, attempts.workspaceId))).where(and(
          eq(attempts.id, row.id), eq(attempts.status, 'EXCHANGING'), eq(connections.generation, row.generation), gt(attempts.expiresAt, new Date())));
        if (!active) throw invalid();
      };
      const client = new MeliClient({ clientId: store.settings.clientId, clientSecret: store.settings.clientSecret,
        ...(current.externalAccountId ? { expectedSellerId: current.externalAccountId } : {}),
        transport: async request => { await assertAttempt(); return (store.settings.transport ?? fetch)(request); },
        beforeRefresh: async () => { throw conflict(); },
        onTokens: async value => {
          tokens = value;
          // Pending authorization is private and durable before using the new grant.
          const saved = await this.db.update(attempts).set({ envelope: store.cipher.seal(value, store.scope(row.workspaceId, row.connectionId, `pending:${row.id}`)) }).where(and(eq(attempts.id, row.id), eq(attempts.status, 'EXCHANGING'))).returning({ id: attempts.id });
          if (!saved.length) throw invalid();
        },
      });
      await client.exchangeAuthorizationCode(canonical.toString(), attempt);
      const identity = await client.getCurrentUser();
      if (!tokens || identity.id !== tokens.userId || !identity.isTestUser || identity.siteId !== 'MLB') throw conflict();
      await this.activeSession(session);
      const pending = await this.db.update(attempts).set({ status: 'PENDING' }).where(and(eq(attempts.id, row.id), eq(attempts.status, 'EXCHANGING'), gt(attempts.expiresAt, new Date()))).returning();
      if (!pending.length) throw invalid();
      return { pending: true as const };
    } catch (error) { await this.db.update(attempts).set({ status: 'FAILED', envelope: null }).where(eq(attempts.id, row.id)); throw error; }
  }
  async confirm(session: AuthenticatedSession, id: string, attemptId: string) {
    const context = { workspaceId: session.account.workspace.id };
    const row = await this.get(context, id); this.implemented(row);
    const store = this.configured(); await this.activeSession(session);
    try {
      await this.db.transaction(async tx => {
        // Session row lock orders confirmation against logout. Workspace owner is checked again.
        const [active] = await tx.select().from(authSessions).where(and(eq(authSessions.id, session.id), eq(authSessions.userId, session.account.user.id), isNull(authSessions.revokedAt), gt(authSessions.expiresAt, new Date()))).for('update');
        const [workspace] = await tx.select().from(workspaces).where(and(eq(workspaces.id, context.workspaceId), eq(workspaces.ownerId, session.account.user.id))).for('update');
        if (!active || !workspace) throw invalid();
        const [current] = await tx.select().from(connections).where(and(eq(connections.id, id), eq(connections.workspaceId, context.workspaceId))).for('update');
        const [pending] = await tx.select().from(attempts).where(and(eq(attempts.id, attemptId), eq(attempts.workspaceId, context.workspaceId), eq(attempts.connectionId, id), eq(attempts.sessionId, session.id), eq(attempts.userId, session.account.user.id), eq(attempts.status, 'PENDING'), gt(attempts.expiresAt, new Date()))).for('update');
        if (!current || !pending?.envelope || current.generation !== pending.generation) throw invalid();
        const tokens = store.cipher.open(pending.envelope, store.scope(context.workspaceId, id, `pending:${attemptId}`)) as MeliTokens;
        if (tokens.expiresAt <= Date.now()+30000 || (current.externalAccountId && current.externalAccountId !== tokens.userId)) throw conflict();
        // The global unique external identity index resolves concurrent claims atomically.
        await tx.update(connections).set({ externalAccountId: tokens.userId, state: 'ACTIVE', credentialState: 'CONNECTED', checkedAt: new Date(), checkStatus: 'AVAILABLE', checkLatencyMs: null }).where(eq(connections.id, id));
        await tx.insert(credentials).values({ ...context, connectionId: id, appId: store.settings.clientId, envelope: store.cipher.seal(tokens, store.scope(context.workspaceId, id)) }).onConflictDoUpdate({ target: credentials.connectionId,
          set: { envelope: store.cipher.seal(tokens, store.scope(context.workspaceId, id)), revision: sql`${credentials.revision}+1`, phase: 'READY', leaseToken: null, leaseUntil: null, updatedAt: new Date() } });
        await tx.update(attempts).set({ status: 'CONFIRMED', envelope: null }).where(eq(attempts.id, attemptId));
      });
    } catch (error) { if (sqlState(error) === '23505') throw conflict(); throw error; }
    return safeConnection(await this.get(context, id));
  }
  async disable(context: WorkspaceContext, id: string) {
    await this.get(context, id);
    await this.db.transaction(async tx => {
      await tx.update(connections).set({ state: 'DISABLED', generation: sql`${connections.generation}+1`, checkedAt: null, checkStatus: null, checkLatencyMs: null }).where(and(eq(connections.workspaceId, context.workspaceId), eq(connections.id, id)));
      await tx.delete(credentials).where(and(eq(credentials.workspaceId, context.workspaceId), eq(credentials.connectionId, id)));
      await tx.update(attempts).set({ status: 'FAILED', envelope: null }).where(and(eq(attempts.workspaceId, context.workspaceId), eq(attempts.connectionId, id), sql`${attempts.status} <> 'CONFIRMED'`));
    });
    return safeConnection(await this.get(context, id));
  }
  async check(context: WorkspaceContext, id: string, localProbe?: () => Promise<{ testUser: boolean }>) {
    const row = await this.get(context, id); this.implemented(row);
    if (row.state !== 'ACTIVE' || row.credentialState !== 'CONNECTED') return safeConnection(row);
    const begin = performance.now(); let status = 'UNAVAILABLE';
    try {
      const result = row.transportMode === 'LOCAL_FIXTURE' ? await localProbe?.() : await this.configured().gateway(context, id, row.externalAccountId!).checkConnection();
      if (result?.testUser) status = 'AVAILABLE';
    } catch { /* Only measured status is public, never remote errors/identity. */ }
    await this.db.update(connections).set({ checkedAt: new Date(), checkStatus: status, checkLatencyMs: Math.ceil(performance.now()-begin) }).where(and(eq(connections.workspaceId, context.workspaceId), eq(connections.id, id), eq(connections.generation, row.generation), eq(connections.state, 'ACTIVE')));
    return safeConnection(await this.get(context, id));
  }
}
