import type { Database } from '@omnihub/database';
import { readFile } from 'node:fs/promises';
import type { CompilerPipeline } from '../pipeline/compiler-pipeline';
import type { DispatchOptions } from '../services/erp-dispatch.service';
import type { OAuthService } from '../services/oauth.service';
import type { MeliGateway } from '@omnihub/marketplace-adapters';
import { approvedErpOrigin } from './erp-target';
import { erpDestinations, workspaces } from '@omnihub/database';
import { and, eq } from 'drizzle-orm';
import { CredentialCipher } from '../services/credential-cipher';
import { ConnectionCredentialStore } from '../services/connection-credentials';
import { ConnectionsService } from '../services/connections.service';
import { ConnectionRuntime } from '../services/connection-runtime';

export interface ErpTargetBinding extends DispatchOptions {
  readonly workspaceId: string;
  readonly erpDestinationId: string;
  readonly webhookSecret: string;
}
export interface PipelineRuntime {
  adminToken: string;
  /** Compatibility settings never assign ownership; unscoped callbacks stay closed. */
  webhookSecret: string; erpUrl: string; mockAdminToken: string;
  pipelines?: readonly CompilerPipeline[];
  erpTargets?: readonly ErpTargetBinding[];
  oauth?: OAuthService;
  smoke?: (externalOrderId?: string) => ReturnType<MeliGateway['smoke']>;
  connectionRuntime?: ConnectionRuntime;
}
export function validateTargetBindings(targets: readonly ErpTargetBinding[]) {
  const destinations = new Set<string>(), urls = new Set<string>(), secrets = new Set<string>();
  for (const target of targets) {
    const endpoint = approvedErpOrigin(target.url);
    if (destinations.has(target.erpDestinationId) || urls.has(endpoint) || secrets.has(target.webhookSecret) || target.adminToken.length < 32 || target.webhookSecret.length < 32) throw new Error('ERP targets require dedicated endpoints, unique secrets and destination identities');
    destinations.add(target.erpDestinationId); urls.add(endpoint); secrets.add(target.webhookSecret);
  }
}
export async function createRuntime(db: Database, env: NodeJS.ProcessEnv = process.env): Promise<PipelineRuntime> {
  const runtime: PipelineRuntime = { adminToken: env.HUB_ADMIN_TOKEN ?? '', webhookSecret: env.ERP_WEBHOOK_SECRET ?? '', erpUrl: env.MOCK_ERP_URL ?? 'http://127.0.0.1:3002', mockAdminToken: env.MOCK_ERP_ADMIN_TOKEN ?? '', pipelines: [], erpTargets: [] };
  if (runtime.adminToken && runtime.adminToken.length < 32) throw new Error('HUB_ADMIN_TOKEN requires at least 32 characters');
  if (env.ERP_TARGETS_FILE) {
    const value: unknown = JSON.parse(await readFile(env.ERP_TARGETS_FILE, 'utf8'));
    if (!Array.isArray(value)) throw new Error('ERP_TARGETS_FILE must contain a target array');
    const targets: ErpTargetBinding[] = value.map((item: unknown) => {
      if (!item || typeof item !== 'object') throw new Error('Invalid ERP target');
      const fields = ['workspaceId','erpDestinationId','configKey','url','adminToken','webhookSecret'] as const;
      for (const key of fields) if (!(key in item) || typeof (item as Record<string, unknown>)[key] !== 'string') throw new Error('Invalid ERP target');
      return item as ErpTargetBinding;
    });
    validateTargetBindings(targets);
    for (const target of targets) {
      const [destination] = await db.select().from(erpDestinations).innerJoin(workspaces, eq(workspaces.id, erpDestinations.workspaceId)).where(and(eq(erpDestinations.id, target.erpDestinationId), eq(erpDestinations.workspaceId, target.workspaceId), eq(workspaces.kind, 'ACCOUNT'))).then(rows => rows.map(row => row.erp_destinations));
      if (!destination) throw new Error('ERP destination not allowed');
      if (destination.configKey !== target.configKey || destination.endpointOrigin !== approvedErpOrigin(target.url)) throw new Error('ERP configuration key/origin mismatch');
    }
    runtime.erpTargets = targets;
  }
  // Opt-in custody; never read/import the global token file or MELI_REFRESH_TOKEN here.
  if (env.CONNECTIONS_ENABLED === 'true') {
    let store: ConnectionCredentialStore | undefined;
    if (env.CONNECTION_KEYS_FILE) {
      for (const name of ['MELI_APP_ID', 'MELI_CLIENT_SECRET', 'MELI_REDIRECT_URI', 'PUBLIC_HUB_URL', 'PUBLIC_DASHBOARD_URL']) if (!env[name] || /SUBSTITUIR|PLACEHOLDER/i.test(env[name]!)) throw new Error('Connection server configuration missing');
      const redirect = new URL(env.MELI_REDIRECT_URI!);
      if (redirect.protocol !== 'https:' || redirect.pathname !== '/api/oauth/meli/callback' || redirect.search || redirect.hash || redirect.username || redirect.password) throw new Error('Exact registered HTTPS callback required');
      const returnUrl = new URL('/connections', env.PUBLIC_DASHBOARD_URL!).toString();
      store = new ConnectionCredentialStore(db, await CredentialCipher.fromFile(env.CONNECTION_KEYS_FILE), { clientId: env.MELI_APP_ID!, clientSecret: env.MELI_CLIENT_SECRET!, redirectUri: env.MELI_REDIRECT_URI!, publicHubUrl: env.PUBLIC_HUB_URL!, returnUrl });
    }
    const pipelines: CompilerPipeline[] = [];
    runtime.pipelines = pipelines;
    runtime.connectionRuntime = new ConnectionRuntime(db, new ConnectionsService(db, store), pipelines, runtime.erpTargets ?? []);
    await runtime.connectionRuntime.reconcile();
  }
  return runtime;
}
