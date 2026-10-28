export type MarketplaceSource = 'MERCADO_LIVRE' | 'SHOPEE' | 'AMAZON' | 'MANUAL';

export type CanonicalOrderStatus =
  | 'PENDING'
  | 'PAID'
  | 'INVOICED'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'CANCELLED';

export interface CanonicalOrderItem {
  readonly sku: string;
  readonly externalItemId: string;
  readonly title: string;
  /** Inteiro não negativo, em centavos. */
  readonly unitPriceCents: number;
  readonly quantity: number;
  readonly currency: string;
}

export interface CanonicalCustomer {
  readonly externalCustomerId: string;
  readonly documentNumber: string;
  readonly name: string;
  readonly email: string;
  readonly phone?: string;
}

export interface CanonicalShippingAddress {
  readonly street: string;
  readonly number: string;
  readonly complement?: string;
  readonly neighborhood: string;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
}

export interface CanonicalOrder {
  readonly id: string;
  readonly source: MarketplaceSource;
  readonly externalOrderId: string;
  readonly createdAt: Date;
  readonly status: CanonicalOrderStatus;
  readonly totalAmountCents: number;
  readonly customer: CanonicalCustomer;
  readonly shippingAddress: CanonicalShippingAddress;
  readonly items: readonly CanonicalOrderItem[];
}
