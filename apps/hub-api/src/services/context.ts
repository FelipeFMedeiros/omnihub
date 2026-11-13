import { connections, erpDestinations, workspaces, type Channel, type Database, type TransportMode } from '@omnihub/database';
import { and, eq } from 'drizzle-orm';
import { HubError } from '../errors';
import type { Transaction } from './transaction';

/** Server-owned envelope. Never part of CanonicalOrder or accepted as browser authorization. */
export interface WorkspaceContext { readonly workspaceId: string }
export interface OrderContext extends WorkspaceContext { readonly connectionId: string | null }
export interface WorkerContext extends WorkspaceContext {
  readonly connectionId: string;
  readonly source: Channel;
  readonly transportMode: TransportMode;
  readonly erpDestinationId: string;
}
export async function requireWorkspace(db: Database | Transaction, context: WorkspaceContext) {
  const [workspace] = await db.select({ id: workspaces.id }).from(workspaces)
    .where(and(eq(workspaces.id, context.workspaceId), eq(workspaces.kind, 'ACCOUNT')));
  if (!workspace) throw new HubError(403, 'WORKSPACE_CLOSED', 'Negócio indisponível para operação.');
}
export async function requireConnection(db: Database | Transaction, context: OrderContext, source: string) {
  await requireWorkspace(db, context);
  if (source === 'MANUAL' && context.connectionId === null) return;
  if (source === 'MANUAL' || !context.connectionId) throw new HubError(422, 'CONNECTION_SOURCE_MISMATCH', 'Origem incompatível com a conexão.');
  const [connection] = await db.select().from(connections).where(and(eq(connections.workspaceId, context.workspaceId), eq(connections.id, context.connectionId), eq(connections.state, 'ACTIVE')));
  if (!connection || connection.platform !== source) throw new HubError(404, 'CONNECTION_NOT_FOUND', 'Conexão indisponível neste negócio.');
  return connection;
}
export async function requireWorker(db: Database | Transaction, context: WorkerContext) {
  const connection = await requireConnection(db, context, context.source);
  if (!connection || connection.transportMode !== context.transportMode) throw new HubError(409, 'CONNECTION_TRANSPORT_MISMATCH', 'Modo de transporte incompatível.');
  await requireDestination(db, context, context.erpDestinationId);
  return connection;
}
export async function requireDestination(db: Database | Transaction, context: WorkspaceContext, id: string) {
  await requireWorkspace(db, context);
  const [destination] = await db.select().from(erpDestinations).where(and(eq(erpDestinations.workspaceId, context.workspaceId), eq(erpDestinations.id, id), eq(erpDestinations.state, 'ACTIVE')));
  if (!destination) throw new HubError(404, 'ERP_DESTINATION_NOT_FOUND', 'Destino ERP indisponível neste negócio.');
  return destination;
}
