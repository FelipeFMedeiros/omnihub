import type { Database } from '@omnihub/database';
import { readFile } from 'node:fs/promises';
import type { CompilerPipeline } from '../pipeline/compiler-pipeline';
import { requireDestination } from '../services/context';
import type { DispatchOptions } from '../services/erp-dispatch.service';
import type { OAuthService } from '../services/oauth.service';
import type { MeliGateway } from '@omnihub/marketplace-adapters';
import { approvedErpOrigin } from './erp-target';

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
      const destination = await requireDestination(db, target, target.erpDestinationId);
      if (destination.configKey !== target.configKey || destination.endpointOrigin !== approvedErpOrigin(target.url)) throw new Error('ERP configuration key/origin mismatch');
    }
    runtime.erpTargets = targets;
  }
  // TASK-014 owns per-connection OAuth/token storage. Never read/import the global token file here.
  return runtime;
}
