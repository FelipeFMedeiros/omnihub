import type { Channel } from './schema';

/** Reserved closed migration context; never an implicit service/browser default. */
export const LEGACY_WORKSPACE_ID = '018f0000-0000-7000-8000-000000000013';
export const LEGACY_ERP_DESTINATION_ID = '018f0000-0000-7000-8000-000000000130';
export function legacyConnectionId(source: Channel): string {
  return { MERCADO_LIVRE: '018f0000-0000-7000-8000-000000000131', SHOPEE: '018f0000-0000-7000-8000-000000000132', AMAZON: '018f0000-0000-7000-8000-000000000133' }[source];
}
