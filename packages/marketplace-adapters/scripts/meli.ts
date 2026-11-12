import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import { AdapterError, createMeliAuthorization, decoder, externalId, MeliClient, validateMeliCallback, validateRedirectUri, type MeliTokens } from '../src';

export const tokenFile = fileURLToPath(new URL('../../../output/meli/tokens.json', import.meta.url));
const evidenceDirectory = fileURLToPath(new URL('../../../output/task-003/', import.meta.url));
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

export async function smokeMeli(client: MeliClient, expectedSellerId: string, orderId?: string) {
  const user = await client.getCurrentUser();
  if (user.id !== externalId(expectedSellerId) || !user.isTestUser || user.siteId !== 'MLB') {
    throw new AdapterError('ADAPTER_RESOURCE_MISMATCH', 'Smoke exige a identidade esperada de um usuário de teste brasileiro.', 403);
  }
  if (orderId) await client.loadOrderInput(externalId(orderId));
  return {
    ok: true, marketplace: 'MERCADO_LIVRE', mode: 'official_api_test_user',
    checkedAt: new Date().toISOString(), identityMatches: true, testUserVerified: true,
    operations: orderId ? ['/users/me', '/orders/:id', 'related_resources_when_present'] : ['/users/me'],
    orderRead: Boolean(orderId), canonicalParsingVerified: false,
  };
}

async function authorize() {
  const settings = loadMeliSettings('authorize');
  const redirectUri = settings.redirectUri;
  if (!redirectUri) return configurationError('Configure a URL de retorno.');
  const authorization = createMeliAuthorization({ clientId: settings.clientId, redirectUri, pkce: settings.pkce });
  const client = new MeliClient({
    ...settings, onTokens: tokens => writeMeliTokens(tokenFile, settings.clientId, tokens),
  });
  let finish: () => void = () => {}; let fail: (error: unknown) => void = () => {};
  const done = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  let processing = false;
  const redirect = new URL(redirectUri);
  const hostname = redirect.protocol === 'http:' && redirect.hostname === '[::1]' ? '::1' : '127.0.0.1';
  const server = Bun.serve({
    hostname, port: settings.port,
    async fetch(request) {
      const received = new URL(request.url);
      if (request.method !== 'GET' || received.pathname !== redirect.pathname) return new Response('Rota não encontrada.', { status: 404 });
      if (processing) return new Response('Autorização já em processamento.', { status: 409 });
      const callback = new URL(redirectUri); callback.search = received.search;
      // Rejeitar state/redirect antes de consumir o único código ou interromper o fluxo.
      try { validateMeliCallback(callback.toString(), authorization.attempt); }
      catch { return new Response('Retorno inválido ou expirado.', { status: 400 }); }
      processing = true;
      try {
        await client.exchangeAuthorizationCode(callback.toString(), authorization.attempt);
        finish(); return new Response('Autorização concluída. Volte ao terminal.');
      } catch (error) {
        fail(error); return new Response('Não foi possível concluir a autorização. Confira o terminal.', { status: 400 });
      }
    },
  });
  const timer = setTimeout(() => fail(new AdapterError('MELI_OAUTH_CALLBACK_REJECTED', 'Tempo de autorização esgotado.', 400)), 10 * 60_000);
  console.log(`Listener de desenvolvimento: http://${hostname === '::1' ? '[::1]' : hostname}:${server.port}${redirect.pathname}`);
  console.log('O redirect cadastrado deve chegar a esse listener. Para HTTPS público, configure seu encaminhamento antes de abrir a URL.');
  console.log(`Abra no navegador e autorize a aplicação com o usuário apropriado:\n${authorization.url}`);
  try { await done; console.log('Autorização concluída. Credenciais salvas em output/meli/tokens.json, ignorado pelo Git.'); }
  finally { clearTimeout(timer); await server.stop(); }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help' || command === 'help') {
    console.log('bun run meli:authorize\nbun run meli:smoke [--order-id ID]\nCredenciais somente no .env e no arquivo privado de tokens.'); return;
  }
  if (command === 'authorize' && args.length === 0) return authorize();
  if (command !== 'smoke' || (args.length !== 0 && !(args.length === 2 && args[0] === '--order-id'))) return configurationError('Comando inválido; use --help.');
  const settings = loadMeliSettings('smoke');
  const initialTokens = await readMeliTokens(tokenFile, settings.clientId);
  const client = new MeliClient({ ...settings, initialTokens, onTokens: tokens => writeMeliTokens(tokenFile, settings.clientId, tokens) });
  const result = await smokeMeli(client, settings.expectedSellerId ?? '', args[1]);
  await mkdir(evidenceDirectory, { recursive: true });
  const path = `${evidenceDirectory}/meli-smoke-${result.checkedAt.replace(/[:.]/g, '-')}.json`;
  await writeFile(path, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result));
}

if (import.meta.main) {
  try { await main(); }
  catch (error) {
    const safe = error instanceof AdapterError ? { code: error.code, message: error.message, status: error.status } : { code: 'MELI_HELPER_FAILED', message: 'Falha no helper local; confira configuração e acesso ao arquivo privado.' };
    console.error(JSON.stringify({ ok: false, error: safe })); process.exitCode = 1;
  }
}
