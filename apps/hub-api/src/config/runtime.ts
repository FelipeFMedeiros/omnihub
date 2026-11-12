import { MeliClient, MeliGateway, loadMeliSettings, readMeliTokens, tokenFile, writeMeliTokens } from '@omnihub/marketplace-adapters';
import type { Database } from '@omnihub/database';
import { CompilerPipeline } from '../pipeline/compiler-pipeline';
import { ErpDispatchService } from '../services/erp-dispatch.service';
import { OAuthService } from '../services/oauth.service';

export interface PipelineRuntime {
  adminToken: string; webhookSecret: string; erpUrl: string; mockAdminToken: string;
  pipeline?: CompilerPipeline; oauth?: OAuthService;
  smoke?: (externalOrderId?: string) => ReturnType<MeliGateway['smoke']>;
}
export async function createRuntime(db: Database, env: NodeJS.ProcessEnv = process.env): Promise<PipelineRuntime> {
  const adminToken = env.HUB_ADMIN_TOKEN ?? '', webhookSecret = env.ERP_WEBHOOK_SECRET ?? '', mockAdminToken = env.MOCK_ERP_ADMIN_TOKEN ?? '';
  const erpUrl = env.MOCK_ERP_URL ?? 'http://127.0.0.1:3002';
  let url: URL;
  try { url = new URL(erpUrl); } catch { throw new Error('MOCK_ERP_URL inválida.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('MOCK_ERP_URL deve ser origem HTTP local sem credenciais.');
  for (const secret of [adminToken, webhookSecret, mockAdminToken]) if (secret && secret.length < 32) throw new Error('Tokens locais configurados exigem ao menos 32 caracteres.');
  const runtime: PipelineRuntime = { adminToken, webhookSecret, erpUrl: url.origin, mockAdminToken };
  if (!env.MELI_APP_ID || !env.MELI_CLIENT_SECRET || !env.MELI_REDIRECT_URI || /SUBSTITUIR/.test(env.MELI_APP_ID + env.MELI_CLIENT_SECRET + env.MELI_REDIRECT_URI)) return runtime;
  const settings = loadMeliSettings('authorize', env);
  if (new URL(settings.redirectUri!).pathname !== '/api/oauth/meli/callback') throw new Error('MELI_REDIRECT_URI deve usar /api/oauth/meli/callback no Hub.');
  const stored = await readMeliTokens(tokenFile, settings.clientId);
  const ownerMatches = !settings.expectedSellerId || stored?.userId === settings.expectedSellerId;
  const client = new MeliClient({ ...settings, initialTokens: ownerMatches ? stored : undefined, refreshToken: ownerMatches ? settings.refreshToken : undefined, onTokens: tokens => writeMeliTokens(tokenFile, settings.clientId, tokens) });
  runtime.oauth = new OAuthService(client, { clientId: settings.clientId, redirectUri: settings.redirectUri!, pkce: settings.pkce });
  if (settings.expectedSellerId) {
    const gateway = new MeliGateway(client, settings.clientId, settings.expectedSellerId);
    runtime.smoke = id => gateway.smoke(id);
    if (mockAdminToken && webhookSecret) runtime.pipeline = new CompilerPipeline(db, gateway, new ErpDispatchService(db, { url: runtime.erpUrl, adminToken: mockAdminToken }));
  }
  return runtime;
}
