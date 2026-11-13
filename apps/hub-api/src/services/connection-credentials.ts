import { connectionCredentials as credentials, connections, type Database } from '@omnihub/database';
import { AdapterError, MeliClient, MeliGateway, type MeliTokens, type SpokeGateway } from '@omnihub/marketplace-adapters';
import { and, eq, sql } from 'drizzle-orm';
import { HubError } from '../errors';
import { CredentialCipher } from './credential-cipher';
import type { WorkspaceContext } from './context';

export interface ConnectionSettings {
  clientId: string; clientSecret: string; redirectUri: string; publicHubUrl: string; returnUrl: string;
  transport?: (request: Request) => Promise<Response>;
}
const reauth = () => new HubError(409, 'REAUTH_REQUIRED', 'Refaça a autorização desta conexão.');
export class ConnectionCredentialStore {
  constructor(readonly db: Database, readonly cipher: CredentialCipher, readonly settings: ConnectionSettings) {}
  scope(workspaceId: string, connectionId: string, purpose = 'tokens') { return { workspaceId, connectionId, appId: this.settings.clientId, purpose }; }
  private async invalidate(context: WorkspaceContext, id: string, lease: string) {
    await this.db.transaction(async tx => {
      const [row] = await tx.select().from(connections).where(and(eq(connections.workspaceId, context.workspaceId), eq(connections.id, id))).for('update');
      if (!row) return;
      const removed = await tx.delete(credentials).where(and(eq(credentials.workspaceId, context.workspaceId), eq(credentials.connectionId, id), eq(credentials.leaseToken, lease))).returning();
      if (removed.length && row.state === 'ACTIVE') await tx.update(connections).set({ credentialState: 'REAUTH_REQUIRED', generation: sql`${connections.generation}+1`, checkedAt: null, checkStatus: null }).where(eq(connections.id, id));
    });
  }
  async use<T>(context: WorkspaceContext, id: string, action: (client: MeliClient) => Promise<T>): Promise<T> {
    const lease = Bun.randomUUIDv7();
    const claim = async () => this.db.transaction(async tx => {
      const [connection] = await tx.select().from(connections).where(and(eq(connections.workspaceId, context.workspaceId), eq(connections.id, id))).for('update');
      if (!connection || connection.state !== 'ACTIVE' || connection.credentialState !== 'CONNECTED' || connection.transportMode !== 'OFFICIAL_TEST_USER') throw reauth();
      const [stored] = await tx.select().from(credentials).where(and(eq(credentials.workspaceId, context.workspaceId), eq(credentials.connectionId, id))).for('update');
      if (!stored || stored.appId !== this.settings.clientId) throw reauth();
      if (stored.leaseUntil && stored.leaseUntil.getTime() > Date.now()) return undefined;
      if (stored.phase === 'ROTATING') {
        await tx.delete(credentials).where(eq(credentials.connectionId, id));
        await tx.update(connections).set({ credentialState: 'REAUTH_REQUIRED', generation: sql`${connections.generation}+1` }).where(eq(connections.id, id));
        return { expiredRotation: true as const };
      }
      await tx.update(credentials).set({ leaseToken: lease, leaseUntil: new Date(Date.now()+120000) }).where(eq(credentials.connectionId, id));
      return { stored, connection };
    });
    let claimed = await claim();
    for (let n = 0; !claimed && n < 250; n++) { await Bun.sleep(20); claimed = await claim(); }
    if (!claimed) throw new HubError(409, 'CONNECTION_BUSY', 'Conexão em uso; tente novamente.');
    if ('expiredRotation' in claimed) throw reauth();
    const { stored, connection } = claimed; let revision = stored.revision, rotation = false, decoded = false;
    const owned = () => and(eq(credentials.workspaceId, context.workspaceId), eq(credentials.connectionId, id), eq(credentials.leaseToken, lease), eq(credentials.revision, revision));
    try {
      // MeliClient validates the decrypted shape and expected identity, never a plaintext fallback.
      const initial = this.cipher.open(stored.envelope, this.scope(context.workspaceId, id)) as MeliTokens;
      const assertActive = async () => {
        const [active] = await this.db.select({ id: connections.id }).from(connections).innerJoin(credentials, eq(credentials.connectionId, connections.id)).where(and(
          eq(connections.id, id), eq(connections.workspaceId, context.workspaceId), eq(connections.state, 'ACTIVE'), eq(connections.generation, connection.generation), owned(), sql`${credentials.leaseUntil} > now()`));
        if (!active) throw reauth();
      };
      const client = new MeliClient({ clientId: this.settings.clientId, clientSecret: this.settings.clientSecret, expectedSellerId: connection.externalAccountId!, initialTokens: initial,
        transport: async request => { await assertActive(); return (this.settings.transport ?? fetch)(request); },
        beforeRefresh: async () => {
          await assertActive();
          const result = await this.db.update(credentials).set({ phase: 'ROTATING' }).where(owned()).returning();
          if (!result.length) throw reauth(); rotation = true;
        },
        onTokens: async tokens => {
          await assertActive();
          const envelope = this.cipher.seal(tokens, this.scope(context.workspaceId, id));
          const updated = await this.db.update(credentials).set({ envelope, revision: revision + 1, phase: 'READY', updatedAt: new Date() }).where(owned()).returning();
          if (!updated.length) throw reauth(); revision++; rotation = false;
        },
      });
      decoded = true;
      return await action(client);
    } catch (error) {
      if (rotation || !decoded || (error instanceof AdapterError && error.status === 401)) await this.invalidate(context, id, lease);
      throw error;
    } finally {
      await this.db.update(credentials).set({ leaseToken: null, leaseUntil: null }).where(owned());
    }
  }
  gateway(context: WorkspaceContext, id: string, externalAccountId: string): SpokeGateway {
    const withGateway = <T>(action: (gateway: MeliGateway) => Promise<T>) => this.use(context, id, client => action(new MeliGateway(client, this.settings.clientId, externalAccountId)));
    // Notification validation is pure; credential access is deferred until authorized operations.
    const validator = new MeliGateway(new MeliClient({ clientId: this.settings.clientId, clientSecret: this.settings.clientSecret, expectedSellerId: externalAccountId }), this.settings.clientId, externalAccountId);
    return { source: 'MERCADO_LIVRE', externalAccountId,
      identifyNotification: raw => validator.identifyNotification(raw),
      loadOrder: orderId => withGateway(gateway => gateway.loadOrder(orderId)),
      updateStock: (mapping, quantity) => withGateway(gateway => gateway.updateStock(mapping, quantity)),
      checkConnection: () => withGateway(gateway => gateway.checkConnection()),
    };
  }
}
