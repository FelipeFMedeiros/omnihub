import type { CanonicalOrder, MarketplaceSource } from '@omnihub/canonical-ir';

export interface OrderParseContext {
  /** Gerado na borda; o parser não gera UUIDs nem consulta o relógio. */
  readonly canonicalOrderId: string;
}

/** Fronteira mínima compartilhada; transporte e autenticação pertencem ao canal. */
export interface SpokeAdapter<TRawOrder, TContext extends OrderParseContext = OrderParseContext> {
  readonly source: Exclude<MarketplaceSource, 'MANUAL'>;
  parseOrderToCanonical(rawOrder: TRawOrder, context: TContext): CanonicalOrder;
}
