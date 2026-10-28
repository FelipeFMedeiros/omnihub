export interface CanonicalProduct {
  readonly id: string;
  readonly sku: string;
  readonly title: string;
  readonly basePriceCents: number;
  readonly currentStock: number;
  readonly reservedStock: number;
  readonly safetyStock: number;
  readonly updatedAt: Date;
}
