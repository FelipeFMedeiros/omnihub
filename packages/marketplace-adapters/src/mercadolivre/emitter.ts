import type { SpokeGateway, SpokeMapping } from '../gateway';
import { MeliClient } from './client';
import { parseMeliOrderNotification, parseMeliOrderToCanonical } from './parser';
import { AdapterError } from '../errors';
import { decodeMeliOrder } from './schemas';
export class MeliGateway implements SpokeGateway {
  readonly source = 'MERCADO_LIVRE' as const;
  constructor(private readonly client: MeliClient, private readonly applicationId: string, private readonly sellerId: string) {}
  get externalAccountId() { return this.sellerId; }
  identifyNotification(raw: unknown) { return { source: this.source, externalOrderId: parseMeliOrderNotification(raw, { applicationId: this.applicationId, sellerId: this.sellerId }).orderId }; }
  async loadOrder(externalOrderId: string) {
    if (!(await this.checkConnection()).testUser) throw new AdapterError('ADAPTER_RESOURCE_MISMATCH', 'Pipeline habilitado somente para vendedor de teste brasileiro.', 403);
    const raw = await this.client.loadOrderInput(externalOrderId);
    return { raw, cancelled:decodeMeliOrder(raw.order).status==='cancelled', parse: (context: { canonicalOrderId: string; mappings: readonly SpokeMapping[] }) => parseMeliOrderToCanonical(raw, {
      canonicalOrderId: context.canonicalOrderId, expectedSellerId: this.sellerId,
      skuMappings: context.mappings.map(m => ({ itemId: m.externalItemId, ...(m.externalVariantId ? { variationId: m.externalVariantId } : {}), sku: m.sku })),
    }) };
  }
  updateStock(mapping: SpokeMapping, availableQuantity: number) { return this.client.updateStock(mapping.externalItemId, mapping.externalVariantId, availableQuantity); }
  async checkConnection() { const user = await this.client.getCurrentUser(); return { testUser: user.isTestUser && user.siteId === 'MLB' }; }
  async smoke(externalOrderId?: string) {
    if (!(await this.checkConnection()).testUser) throw new AdapterError('ADAPTER_RESOURCE_MISMATCH','Smoke exige vendedor brasileiro de teste.',403);
    if (externalOrderId) await this.loadOrder(externalOrderId);
    return { ok:true,marketplace:this.source,mode:'official_api_test_user',checkedAt:new Date().toISOString(),identityMatches:true,testUserVerified:true,
      operations:externalOrderId?['/users/me','/orders/:id','related_resources_when_present']:['/users/me'],orderRead:Boolean(externalOrderId),canonicalParsingVerified:false };
  }
}
