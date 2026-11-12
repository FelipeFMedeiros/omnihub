import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AdapterError } from '../errors';
import { externalId } from './schemas';

export interface MeliAuthorizationAttempt {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeVerifier?: string;
  readonly expiresAt: number;
}

export function validateRedirectUri(value: string): URL {
  let uri: URL;
  try { uri = new URL(value); } catch { throw new AdapterError('MELI_INVALID_CONFIGURATION', 'Configure uma URL de retorno válida.', 400); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname);
  if ((uri.protocol !== 'https:' && !(uri.protocol === 'http:' && local)) || uri.username || uri.password || uri.hash
    || ['code', 'state', 'error'].some(key => uri.searchParams.has(key))) {
    throw new AdapterError('MELI_INVALID_CONFIGURATION', 'URL de retorno deve ser HTTPS (ou loopback local), sem credenciais ou parâmetros OAuth.', 400);
  }
  return uri;
}

export function createMeliAuthorization(options: { clientId: string; redirectUri: string; pkce?: boolean; now?: number }): { url: string; attempt: MeliAuthorizationAttempt } {
  const clientId = externalId(options.clientId);
  validateRedirectUri(options.redirectUri);
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now)) throw new AdapterError('MELI_INVALID_CONFIGURATION', 'Relógio de autorização inválido.', 400);
  const codeVerifier = options.pkce === false ? undefined : randomBytes(32).toString('base64url');
  const attempt: MeliAuthorizationAttempt = {
    clientId, redirectUri: options.redirectUri, state: randomBytes(32).toString('base64url'),
    ...(codeVerifier ? { codeVerifier } : {}), expiresAt: now + 10 * 60_000,
  };
  const url = new URL('https://auth.mercadolivre.com.br/authorization');
  url.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: attempt.redirectUri, state: attempt.state }).toString();
  if (codeVerifier) {
    url.searchParams.set('code_challenge', createHash('sha256').update(codeVerifier).digest('base64url'));
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return { url: url.toString(), attempt };
}

export function validateMeliCallback(callbackUrl: string, attempt: MeliAuthorizationAttempt, now = Date.now()): string {
  const reject = (): never => { throw new AdapterError('MELI_OAUTH_CALLBACK_REJECTED', 'Retorno OAuth inválido, expirado ou não autorizado.', 400); };
  let callback: URL;
  try { callback = new URL(callbackUrl); } catch { return reject(); }
  const expected = validateRedirectUri(attempt.redirectUri);
  if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.username || callback.password || callback.hash
    || !Number.isFinite(now) || now >= attempt.expiresAt || callback.searchParams.has('error')) return reject();
  for (const key of new Set(expected.searchParams.keys())) {
    if (JSON.stringify(callback.searchParams.getAll(key)) !== JSON.stringify(expected.searchParams.getAll(key))) return reject();
  }
  const states = callback.searchParams.getAll('state');
  const codes = callback.searchParams.getAll('code');
  if (states.length !== 1 || codes.length !== 1 || !codes[0] || codes[0].length > 4096) return reject();
  const received = Buffer.from(states[0] ?? ''), stored = Buffer.from(attempt.state);
  if (!stored.length || received.length !== stored.length || !timingSafeEqual(received, stored)) return reject();
  return codes[0];
}
