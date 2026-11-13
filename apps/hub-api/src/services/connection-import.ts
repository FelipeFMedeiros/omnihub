import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { realpath, readFile } from 'node:fs/promises';
import { connectionCredentials, connectionImports, connections, workspaces } from '@omnihub/database';
import { MeliClient, readMeliTokens } from '@omnihub/marketplace-adapters';
import { and, eq, sql } from 'drizzle-orm';
import { ConnectionCredentialStore } from './connection-credentials';
import { HubError } from '../errors';

export interface ConnectionImport {
  workspaceId: string; connectionId: string; verifiedOwnerId: string; expectedAccountId: string;
  verificationReference: string; source: string;
}
/** Explicit operator-only operation. No discovery, no refresh, no legacy claim. */
export async function importConnection(store: ConnectionCredentialStore, input: ConnectionImport) {
  if (input.verificationReference.trim().length < 8 || !/^[1-9][0-9]{0,99}$/.test(input.expectedAccountId)) throw new HubError(422, 'IMPORT_ATTESTATION_REQUIRED', 'Confirme proprietário, conta e comprovação.');
  const path = await realpath(input.source);
  if (basename(path) !== 'tokens.json' || /bootstrap/i.test(path)) throw new HubError(403, 'IMPORT_SOURCE_FORBIDDEN', 'Somente o arquivo explícito do vendedor é permitido.');
  const tokens = await readMeliTokens(path, store.settings.clientId);
  if (!tokens || tokens.userId !== input.expectedAccountId || tokens.expiresAt <= Date.now()+60000) throw new HubError(409, 'IMPORT_FRESH_GRANT_REQUIRED', 'O custódio deve fornecer autorização fresca da conta verificada.');
  const client = new MeliClient({ clientId: store.settings.clientId, clientSecret: store.settings.clientSecret, expectedSellerId: input.expectedAccountId, initialTokens: tokens,
    beforeRefresh: async () => { throw new HubError(409, 'IMPORT_REFRESH_FORBIDDEN', 'O importador não rotaciona a autorização de origem.'); }, transport: store.settings.transport });
  const user = await client.getCurrentUser();
  if (!user.isTestUser || user.siteId !== 'MLB' || user.id !== tokens.userId) throw new HubError(403, 'IMPORT_IDENTITY_REJECTED', 'Importação exige a identidade de teste brasileira esperada.');
  const digest = createHash('sha256').update(await readFile(path)).digest('hex');
  await store.db.transaction(async tx => {
    const [workspace] = await tx.select().from(workspaces).where(and(eq(workspaces.id, input.workspaceId), eq(workspaces.ownerId, input.verifiedOwnerId), eq(workspaces.kind, 'ACCOUNT'))).for('update');
    const [connection] = await tx.select().from(connections).where(and(eq(connections.workspaceId, input.workspaceId), eq(connections.id, input.connectionId))).for('update');
    if (!workspace || !connection || connection.platform !== 'MERCADO_LIVRE' || connection.transportMode !== 'OFFICIAL_TEST_USER' || connection.state !== 'DISABLED' || connection.externalAccountId !== null) throw new HubError(409, 'IMPORT_TARGET_REJECTED', 'Use uma conexão nova do proprietário verificado, fora do legado.');
    await tx.insert(connectionImports).values({ workspaceId: input.workspaceId, connectionId: input.connectionId, sourceDigest: digest, verificationReference: input.verificationReference });
    await tx.insert(connectionCredentials).values({ workspaceId: input.workspaceId, connectionId: input.connectionId, appId: store.settings.clientId, envelope: store.cipher.seal(tokens, store.scope(input.workspaceId, input.connectionId)) });
    await tx.update(connections).set({ externalAccountId: user.id, state: 'ACTIVE', credentialState: 'CONNECTED', generation: sql`${connections.generation}+1`, checkedAt: new Date(), checkStatus: 'AVAILABLE' }).where(eq(connections.id, input.connectionId));
  });
  return { ok: true, mode: 'official_api_test_user', identityMatches: true, testUserVerified: true, operations: ['/users/me'], sourceRefreshed: false, checkedAt: new Date().toISOString() };
}
