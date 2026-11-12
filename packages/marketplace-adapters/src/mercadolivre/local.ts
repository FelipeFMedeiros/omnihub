import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import { AdapterError } from '../errors';
import { decoder, externalId } from './schemas';
import { validateRedirectUri } from './oauth';
import type { MeliTokens } from './client';
export const tokenFile = fileURLToPath(new URL('../../../../output/meli/tokens.json', import.meta.url));
const storedSchema = decoder(Type.Object({
  version: Type.Literal(1), clientId: Type.String({ pattern: '^[1-9][0-9]*$' }),
  tokens: Type.Object({
    accessToken: Type.String({ minLength: 1 }), refreshToken: Type.String({ minLength: 1 }),
    userId: Type.String({ pattern: '^[1-9][0-9]*$' }), expiresAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  }, { additionalProperties: false }),
}, { additionalProperties: false }));

function configurationError(message: string): never { throw new AdapterError('MELI_INVALID_CONFIGURATION', message, 400); }
function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value || /SUBSTITUIR|PLACEHOLDER/i.test(value)) return configurationError(`Preencha ${key} no .env local.`);
  return value;
}
export function loadMeliSettings(mode: 'authorize' | 'smoke', env: NodeJS.ProcessEnv = process.env) {
  const clientId = externalId(required(env, 'MELI_APP_ID'));
  const clientSecret = required(env, 'MELI_CLIENT_SECRET');
  const seller = env.MELI_TEST_SELLER_ID?.trim();
  const expectedSellerId = seller && !/SUBSTITUIR/i.test(seller) ? externalId(seller) : undefined;
  if (mode === 'smoke' && !expectedSellerId) return configurationError('Preencha MELI_TEST_SELLER_ID para limitar o smoke ao vendedor de teste.');
  const redirectUri = mode === 'authorize' ? required(env, 'MELI_REDIRECT_URI') : undefined;
  const pkceSetting = env.MELI_USE_PKCE ?? 'true';
  if (!['true', 'false'].includes(pkceSetting)) return configurationError('MELI_USE_PKCE deve ser true ou false.');
  let port = Number(env.MELI_OAUTH_LISTEN_PORT ?? 3001);
  if (redirectUri) {
    const redirect = validateRedirectUri(redirectUri);
    if (redirect.protocol === 'http:') {
      const redirectPort = Number(redirect.port || 80);
      if (env.MELI_OAUTH_LISTEN_PORT && port !== redirectPort) return configurationError('A porta local deve corresponder ao redirect HTTP de loopback.');
      port = redirectPort;
    }
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return configurationError('MELI_OAUTH_LISTEN_PORT inválida.');
  const refresh = env.MELI_REFRESH_TOKEN?.trim();
  return {
    clientId, clientSecret, expectedSellerId, redirectUri, port, pkce: pkceSetting === 'true',
    refreshToken: refresh && !/SUBSTITUIR/i.test(refresh) ? refresh : undefined,
  };
}

export async function readMeliTokens(path: string, clientId: string): Promise<MeliTokens | undefined> {
  try {
    if ((await stat(path)).size > 65536) return configurationError('Arquivo local de credenciais inválido; refaça a autorização.');
    const stored = storedSchema(JSON.parse(await readFile(path, 'utf8')) as unknown);
    if (stored.clientId !== clientId) return configurationError('Arquivo local pertence a outra aplicação; preserve-o antes de autorizar a aplicação atual.');
    return stored.tokens;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
    if (error instanceof AdapterError && error.code === 'MELI_INVALID_CONFIGURATION') throw error;
    return configurationError('Não foi possível ler as credenciais locais; confira o arquivo ou refaça a autorização.');
  }
}

/** Arquivo privado de desenvolvimento. Não é um store multiusuário/multiprocesso. */
export async function writeMeliTokens(path: string, clientId: string, tokens: MeliTokens): Promise<void> {
  const stored = storedSchema({ version: 1, clientId, tokens });
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}
