import { authSessions, connections, erpDestinations, legacyClaims, products, canonicalOrders, pipelineJobs, workspaces, type Database } from '@omnihub/database';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { HubError } from '../errors';
import { inTransaction } from './transaction';

export interface LegacyClaim {
  readonly legacyWorkspaceId: string;
  readonly emptyWorkspaceId: string;
  readonly verifiedOwnerId: string;
  /** Reference to the operator's independent verification, never a password/token. */
  readonly verificationReference: string;
}
/** Local operator command only. Retains every historical UUID, including the legacy workspace. */
export async function claimLegacy(db: Pick<Database, 'transaction'>, input: LegacyClaim) {
  if (input.legacyWorkspaceId === input.emptyWorkspaceId || input.verificationReference.trim().length < 8 || input.verificationReference.length > 200) throw new HubError(422, 'INVALID_LEGACY_CLAIM', 'Informe contexto e comprovação inequívocos.');
  return inTransaction(db, async tx => {
    const rows = await tx.select().from(workspaces).where(inArray(workspaces.id, [input.legacyWorkspaceId, input.emptyWorkspaceId])).orderBy(asc(workspaces.id)).for('update');
    const legacy = rows.find(w => w.id === input.legacyWorkspaceId), target = rows.find(w => w.id === input.emptyWorkspaceId);
    if (!legacy || legacy.kind !== 'LEGACY_CLOSED' || legacy.ownerId !== null || !target || target.kind !== 'ACCOUNT' || target.ownerId !== input.verifiedOwnerId) throw new HubError(409, 'LEGACY_CLAIM_CONFLICT', 'Origem fechada ou proprietário/destino incompatíveis.');
    // Locking the parent also fences concurrent FK inserts while checking the empty destination.
    for (const table of [products, connections, erpDestinations, canonicalOrders, pipelineJobs]) {
      const found = await tx.select({ workspaceId: table.workspaceId }).from(table).where(eq(table.workspaceId, target.id)).limit(1);
      if (found.length) throw new HubError(409, 'LEGACY_TARGET_NOT_EMPTY', 'O destino precisa estar vazio; não há mesclagem automática.');
    }
    await tx.delete(workspaces).where(and(eq(workspaces.id, target.id), eq(workspaces.ownerId, input.verifiedOwnerId)));
    await tx.update(workspaces).set({ ownerId: input.verifiedOwnerId, kind: 'ACCOUNT', name: target.name }).where(eq(workspaces.id, legacy.id));
    await tx.insert(legacyClaims).values({ workspaceId: legacy.id, ownerId: input.verifiedOwnerId, replacedEmptyWorkspaceId: target.id, verificationReference: input.verificationReference.trim() });
    await tx.update(authSessions).set({ revokedAt: new Date() }).where(eq(authSessions.userId, input.verifiedOwnerId));
    // Connections and ERP remain disabled; a claim never imports or activates credentials.
    return { workspaceId: legacy.id, replacedEmptyWorkspaceId: target.id, ownerId: input.verifiedOwnerId, sessionsRevoked: true as const };
  });
}
