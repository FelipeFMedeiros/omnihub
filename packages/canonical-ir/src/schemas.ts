import { Type } from '@sinclair/typebox';

// Patterns explícitos mantêm a validação independente de registros globais de formatos.
const uuid = () => Type.String({
  minLength: 36, maxLength: 36,
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
});
const digits = (length: number) => Type.String({ minLength: length, maxLength: length, pattern: '^[0-9]+$' });
const cents = () => Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const stock = () => Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const strict = { additionalProperties: false } as const;

export const MarketplaceSourceSchema = Type.Union([
  Type.Literal('MERCADO_LIVRE'), Type.Literal('SHOPEE'),
  Type.Literal('AMAZON'), Type.Literal('MANUAL'),
]);

export const CanonicalOrderStatusSchema = Type.Union([
  Type.Literal('PENDING'), Type.Literal('PAID'), Type.Literal('INVOICED'),
  Type.Literal('SHIPPED'), Type.Literal('DELIVERED'), Type.Literal('CANCELLED'),
]);

export const StockMovementReasonSchema = Type.Union([
  Type.Literal('SALE'), Type.Literal('CANCELLATION'),
  Type.Literal('ERP_SYNC'), Type.Literal('MANUAL_ADJUST'),
]);

export const CanonicalOrderItemSchema = Type.Object({
  sku: Type.String({ minLength: 1, maxLength: 100 }),
  externalItemId: Type.String({ minLength: 1, maxLength: 150 }),
  title: Type.String({ minLength: 1, maxLength: 500 }),
  unitPriceCents: cents(),
  quantity: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  currency: Type.String({ minLength: 3, maxLength: 3, pattern: '^[A-Z]{3}$', default: 'BRL' }),
}, strict);

export const CanonicalCustomerSchema = Type.Object({
  externalCustomerId: Type.String({ minLength: 1, maxLength: 100 }),
  documentNumber: Type.Union([digits(11), digits(14)]),
  name: Type.String({ minLength: 2, maxLength: 200 }),
  email: Type.String({ maxLength: 254, pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' }),
  phone: Type.Optional(Type.String({ maxLength: 30 })),
}, strict);

export const CanonicalShippingAddressSchema = Type.Object({
  street: Type.String({ minLength: 1, maxLength: 255 }),
  number: Type.String({ minLength: 1, maxLength: 30 }),
  complement: Type.Optional(Type.String({ maxLength: 120 })),
  neighborhood: Type.String({ minLength: 1, maxLength: 120 }),
  city: Type.String({ minLength: 1, maxLength: 120 }),
  state: Type.String({ minLength: 2, maxLength: 2, pattern: '^[A-Z]{2}$' }),
  postalCode: digits(8),
}, strict);

export const CanonicalOrderSchema = Type.Object({
  id: uuid(),
  source: MarketplaceSourceSchema,
  externalOrderId: Type.String({ minLength: 1, maxLength: 100 }),
  createdAt: Type.Date(),
  status: CanonicalOrderStatusSchema,
  totalAmountCents: cents(),
  customer: CanonicalCustomerSchema,
  shippingAddress: CanonicalShippingAddressSchema,
  items: Type.Array(CanonicalOrderItemSchema, { minItems: 1 }),
}, strict);

export const CanonicalProductSchema = Type.Object({
  id: uuid(),
  sku: Type.String({ minLength: 1, maxLength: 100 }),
  title: Type.String({ minLength: 1 }),
  basePriceCents: cents(),
  currentStock: stock(),
  reservedStock: stock(),
  safetyStock: stock(),
  updatedAt: Type.Date(),
}, strict);

export const CanonicalStockMovementSchema = Type.Object({
  id: uuid(),
  productId: uuid(),
  sku: Type.String({ minLength: 1, maxLength: 100 }),
  orderId: Type.Optional(uuid()),
  delta: Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
  reason: StockMovementReasonSchema,
  availableAfter: stock(),
  timestamp: Type.Date(),
}, strict);
