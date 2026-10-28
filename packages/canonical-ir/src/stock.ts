export type StockMovementReason = 'SALE' | 'CANCELLATION' | 'ERP_SYNC' | 'MANUAL_ADJUST';

export interface CanonicalStockMovement {
  readonly id: string;
  readonly productId: string;
  readonly sku: string;
  readonly orderId?: string;
  readonly delta: number;
  readonly reason: StockMovementReason;
  /** Saldo físico menos reservado, sem subtrair a margem de segurança. */
  readonly availableAfter: number;
  readonly timestamp: Date;
}
