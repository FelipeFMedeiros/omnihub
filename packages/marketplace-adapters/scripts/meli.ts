import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AdapterError, createMeliAuthorization, externalId, MeliClient, validateMeliCallback } from '../src';
import { loadMeliSettings, readMeliTokens, tokenFile, writeMeliTokens } from '../src/mercadolivre/local';
export { loadMeliSettings, readMeliTokens, tokenFile, writeMeliTokens } from '../src/mercadolivre/local';
const evidenceDirectory = fileURLToPath(new URL('../../../output/task-004/', import.meta.url));
function configurationError(message: string): never { throw new AdapterError('MELI_INVALID_CONFIGURATION', message, 400); }
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
    console.log('bun run meli:authorize (Hub ativo)\nbun run meli:smoke [--order-id ID]\nAlternativa standalone: authorize-standalone, com API parada.\nCredenciais somente no .env e no arquivo privado de tokens.'); return;
  }
  if (command === 'authorize-standalone' && args.length === 0) return authorize();
  if (command === 'authorize' && args.length === 0) {
    const admin = process.env.HUB_ADMIN_TOKEN ?? '', port = Number(process.env.HUB_PORT ?? 3000);
    if (admin.length < 32 || !Number.isInteger(port) || port < 1 || port > 65535) return configurationError('Configure HUB_ADMIN_TOKEN e HUB_PORT; inicie dev:api.');
    let response: Response;
    try { response = await fetch(`http://127.0.0.1:${port}/api/oauth/meli/start`, { method:'POST', redirect:'error', signal:AbortSignal.timeout(5000), headers:{Authorization:`Bearer ${admin}`} }); }
    catch { return configurationError('Inicie o Hub antes de executar meli:authorize.'); }
    if (!response.ok) return configurationError('O Hub rejeitou o inicio OAuth; confira suas configuracoes privadas.');
    const result: unknown = await response.json();
    if (!result || typeof result !== 'object' || !('authorizationUrl' in result) || typeof result.authorizationUrl !== 'string') return configurationError('Resposta OAuth do Hub invalida.');
    console.log(`Abra no navegador e autorize a aplicacao:\n${result.authorizationUrl}`); return;
  }
  if (command !== 'smoke' || (args.length !== 0 && !(args.length === 2 && args[0] === '--order-id'))) return configurationError('Comando inválido; use --help.');
  const admin = process.env.HUB_ADMIN_TOKEN ?? '', port = Number(process.env.HUB_PORT ?? 3000);
  if (admin.length < 32 || !Number.isInteger(port) || port < 1 || port > 65535) return configurationError('Configure HUB_ADMIN_TOKEN e HUB_PORT; inicie dev:api.');
  const response = await fetch(`http://127.0.0.1:${port}/api/oauth/meli/smoke`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(120000),headers:{Authorization:`Bearer ${admin}`,'Content-Type':'application/json'},body:JSON.stringify(args[1]?{externalOrderId:externalId(args[1])}:{})});
  if (!response.ok) throw new AdapterError('MELI_HTTP_ERROR','Smoke oficial rejeitado pelo Hub; confira configuracao e autorizacao do vendedor de teste.',response.status);
  const result = await response.json() as {checkedAt:string};
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
