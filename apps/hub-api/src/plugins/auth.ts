import { authSessions, users, workspaces, type Database } from '@omnihub/database';
import { and, eq, isNull } from 'drizzle-orm';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isLoopback, type SecurityConfig } from '../config/security';
import { HubError } from '../errors';
import { sqlState } from '../services/transaction';
import { requireTurnstile, type TurnstileVerifier } from './turnstile';

export const SESSION_COOKIE = 'omnihub_session';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const passwordOptions = { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3 } as const;
let dummyHash: Promise<string> | undefined;
const unauthorized = () => new HubError(401, 'UNAUTHENTICATED', 'Sessão ausente, inválida ou expirada.');

export function requireOrigin(request: Request, origins: readonly string[]) {
  const origin = request.headers.get('origin');
  if (!origin || !origins.includes(origin)) throw new HubError(403, 'ORIGIN_NOT_ALLOWED', 'Origem da requisição não permitida.');
}

/** Operação CLI local: nunca habilitar os dados globais para um navegador. */
export function requireOperator(request: Request, token: string) {
  if (request.headers.has('origin') || request.headers.has('sec-fetch-site')) throw new HubError(403, 'OPERATOR_BROWSER_FORBIDDEN', 'Operação disponível somente ao operador local.');
  if (token.length < 32) throw new HubError(503, 'LOCAL_ADMIN_NOT_CONFIGURED', 'Configure HUB_ADMIN_TOKEN para as operações locais.');
  const expected = Buffer.from(`Bearer ${token}`), received = Buffer.from(request.headers.get('authorization') ?? '');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new HubError(401, 'UNAUTHORIZED', 'Credencial administrativa local exigida.');
}

export function sessionCookie(config: SecurityConfig, token = '', clear = false): string {
  const secure = new URL(config.publicHubUrl).protocol === 'https:';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : config.sessionTtlSeconds}${clear ? '; Expires=Thu, 01 Jan 1970 00:00:00 GMT' : ''}${secure ? '; Secure' : ''}`;
}

export function requireAuthTransport(request: Request, config: SecurityConfig) {
  const requestUrl = new URL(request.url);
  if (new URL(config.publicHubUrl).protocol === 'http:' &&
      (config.production || requestUrl.protocol !== 'http:' || !isLoopback(requestUrl.hostname))) {
    throw new HubError(403, 'AUTH_HTTPS_REQUIRED', 'Autenticação exige HTTPS; HTTP somente em loopback local.');
  }
}

export interface AccountSession {
  readonly user: { readonly id: string; readonly name: string; readonly email: string };
  readonly workspace: { readonly id: string; readonly name: string };
  readonly expiresAt: string;
  readonly csrfToken: string;
}
export interface AuthenticatedSession { readonly id: string; readonly account: AccountSession }

export class AuthService {
  private readonly key: Uint8Array;
  constructor(private readonly db: Database, readonly config: SecurityConfig) { this.key = new TextEncoder().encode(config.jwtSecret); }

  private csrf(sid: string): string { return createHmac('sha256', this.key).update(`omnihub-csrf\0${sid}`).digest('base64url'); }
  private async issue(user: AccountSession['user'], workspace: AccountSession['workspace']) {
    const issuedAt = Math.floor(Date.now() / 1000), expiresAt = issuedAt + this.config.sessionTtlSeconds;
    const session = { id: Bun.randomUUIDv7(), userId: user.id, issuedAt: new Date(issuedAt * 1000), expiresAt: new Date(expiresAt * 1000) };
    const token = await new SignJWT({ sid: session.id }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(user.id).setIssuer(this.config.issuer).setAudience(this.config.audience)
      .setIssuedAt(issuedAt).setExpirationTime(expiresAt).sign(this.key);
    return { session, token, account: { user, workspace, expiresAt: session.expiresAt.toISOString(), csrfToken: this.csrf(session.id) } };
  }

  private email(value: string): string {
    const normalized = value.trim().toLowerCase();
    if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new HubError(422, 'INVALID_EMAIL', 'Informe um e-mail válido.');
    return normalized;
  }

  async register(input: { name: string; email: string; password: string }) {
    const name = input.name.trim().normalize('NFC'), email = this.email(input.email);
    if (!name || name.length > 120 || input.password.length < 12 || input.password.length > 128) throw new HubError(422, 'INVALID_REGISTRATION', 'Nome ou senha incompatível com o cadastro.');
    const passwordHash = await Bun.password.hash(input.password, passwordOptions);
    try {
      return await this.db.transaction(async tx => {
        const [user] = await tx.insert(users).values({ name, email, passwordHash }).returning({ id: users.id, name: users.name, email: users.email });
        if (!user) throw new Error('User insert failed');
        const [workspace] = await tx.insert(workspaces).values({ ownerId: user.id }).returning({ id: workspaces.id, name: workspaces.name });
        if (!workspace) throw new Error('Workspace insert failed');
        const issued = await this.issue(user, workspace);
        await tx.insert(authSessions).values(issued.session);
        return { token: issued.token, account: issued.account };
      });
    } catch (error) {
      if (sqlState(error) === '23505') throw new HubError(409, 'ACCOUNT_ALREADY_EXISTS', 'Não foi possível criar a conta com este e-mail.');
      throw error;
    }
  }

  async login(input: { email: string; password: string }) {
    const email = this.email(input.email);
    const [record] = await this.db.select({ user: { id: users.id, name: users.name, email: users.email }, passwordHash: users.passwordHash,
      workspace: { id: workspaces.id, name: workspaces.name } }).from(users).innerJoin(workspaces, eq(workspaces.ownerId, users.id)).where(eq(users.email, email));
    dummyHash ??= Bun.password.hash('omnihub-constant-time-unknown-account', passwordOptions);
    const valid = await Bun.password.verify(input.password, record?.passwordHash ?? await dummyHash);
    if (!record || !valid) throw new HubError(401, 'INVALID_CREDENTIALS', 'E-mail ou senha inválidos.');
    const issued = await this.issue(record.user, record.workspace);
    await this.db.insert(authSessions).values(issued.session);
    return { token: issued.token, account: issued.account };
  }

  async authenticate(request: Request): Promise<AuthenticatedSession> {
    const cookies = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${SESSION_COOKIE}=`));
    if (cookies.length !== 1) throw unauthorized();
    const token = cookies[0]!.slice(SESSION_COOKIE.length + 1);
    if (!token || token.length > 4096) throw unauthorized();
    let claims: JWTPayload;
    try {
      const result = await jwtVerify(token, this.key, {
        algorithms: ['HS256'], typ: 'JWT', issuer: this.config.issuer, audience: this.config.audience,
        requiredClaims: ['sub', 'sid', 'iss', 'aud', 'iat', 'exp'], maxTokenAge: this.config.sessionTtlSeconds,
      });
      claims = result.payload;
    } catch { throw unauthorized(); }
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.sub !== 'string' || !uuid.test(claims.sub) || typeof claims.sid !== 'string' || !uuid.test(claims.sid) ||
        !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || claims.iat! > now || claims.exp! <= claims.iat! ||
        claims.exp! - claims.iat! > this.config.sessionTtlSeconds) throw unauthorized();
    const [record] = await this.db.select({
      id: authSessions.id, issuedAt: authSessions.issuedAt, expiresAt: authSessions.expiresAt,
      user: { id: users.id, name: users.name, email: users.email }, workspace: { id: workspaces.id, name: workspaces.name },
    }).from(authSessions).innerJoin(users, eq(users.id, authSessions.userId)).innerJoin(workspaces, eq(workspaces.ownerId, users.id))
      .where(and(eq(authSessions.id, claims.sid), eq(authSessions.userId, claims.sub), isNull(authSessions.revokedAt)));
    if (!record || record.expiresAt.getTime() <= Date.now() || record.issuedAt.getTime() !== claims.iat! * 1000 || record.expiresAt.getTime() !== claims.exp! * 1000) throw unauthorized();
    return { id: record.id, account: { user: record.user, workspace: record.workspace, expiresAt: record.expiresAt.toISOString(), csrfToken: this.csrf(record.id) } };
  }

  requireCsrf(request: Request, session: AuthenticatedSession) {
    const actual = Buffer.from(request.headers.get('x-csrf-token') ?? ''), expected = Buffer.from(session.account.csrfToken);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new HubError(403, 'CSRF_INVALID', 'Token CSRF ausente ou inválido.');
  }

  async logout(session: AuthenticatedSession) {
    await this.db.update(authSessions).set({ revokedAt: new Date() }).where(and(eq(authSessions.id, session.id), isNull(authSessions.revokedAt)));
  }
}

/** Base para TASK-014/simulação futura; nenhuma rota global aceita essa sessão. */
export async function requireSensitiveAction(request: Request, auth: AuthService, origins: readonly string[], verifier: TurnstileVerifier,
  challenge: { token?: string; ip: string; action: string }): Promise<AuthenticatedSession> {
  requireAuthTransport(request, auth.config);
  requireOrigin(request, origins);
  const session = await auth.authenticate(request);
  auth.requireCsrf(request, session);
  await requireTurnstile(verifier, challenge.token, challenge.ip, { action: challenge.action, cdata: session.account.csrfToken });
  return session;
}
