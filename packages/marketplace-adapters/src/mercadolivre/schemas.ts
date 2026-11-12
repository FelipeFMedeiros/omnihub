import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { AdapterError } from '../errors';

// Projeções de leitura: a API pode acrescentar campos; não se exige que eles virem IR.
const object = { additionalProperties: true } as const;
export const ExternalIdSchema = Type.Union([
  Type.String({ minLength: 1, maxLength: 100, pattern: '^[1-9][0-9]*$' }),
  Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
]);
const nullableString = Type.Optional(Type.Union([Type.String(), Type.Null()]));
const optionalId = Type.Optional(Type.Union([ExternalIdSchema, Type.Null()]));
const money = Type.Union([Type.Number({ minimum: 0 }), Type.String({ pattern: '^[0-9]+(?:\\.[0-9]+)?$' })]);
const phone = Type.Optional(Type.Union([Type.Object({ area_code: nullableString, number: nullableString }, object), Type.Null()]));
const address = Type.Object({
  street_name: nullableString,
  street_number: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Null()])),
  zip_code: nullableString,
  city: Type.Optional(Type.Union([Type.Object({ name: nullableString }, object), Type.Null()])),
  state: Type.Optional(Type.Union([Type.Object({ id: nullableString }, object), Type.Null()])),
  neighborhood: Type.Optional(Type.Union([Type.Object({ name: nullableString }, object), Type.Null()])),
  comment: nullableString,
  country: Type.Optional(Type.Object({ id: Type.String() }, object)),
}, object);

export const MeliOrderSchema = Type.Object({
  id: ExternalIdSchema,
  status: Type.String(), date_created: Type.String(), currency_id: Type.String(), total_amount: money,
  context: Type.Optional(Type.Object({ site: Type.Optional(Type.String()) }, object)),
  buyer: Type.Object({
    id: ExternalIdSchema, first_name: nullableString, last_name: nullableString, email: nullableString, phone,
    billing_info: Type.Optional(Type.Union([Type.Object({ id: optionalId, doc_type: nullableString, doc_number: nullableString }, object), Type.Null()])),
  }, object),
  seller: Type.Object({ id: ExternalIdSchema }, object),
  shipping: Type.Optional(Type.Union([Type.Object({ id: optionalId, receiver_address: Type.Optional(address) }, object), Type.Null()])),
  order_items: Type.Array(Type.Object({
    item: Type.Object({
      id: Type.String({ pattern: '^MLB[0-9]+$' }), title: Type.String({ minLength: 1 }),
      variation_id: optionalId, seller_sku: nullableString,
    }, object),
    quantity: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    unit_price: money, currency_id: Type.Optional(Type.String()),
  }, object), { minItems: 1 }),
}, object);

export const MeliShipmentSchema = Type.Object({
  id: ExternalIdSchema,
  destination: Type.Object({ receiver_id: ExternalIdSchema, shipping_address: address, receiver_phone: nullableString }, object),
}, object);

export const MeliBillingInfoSchema = Type.Object({
  site_id: Type.Literal('MLB'),
  buyer: Type.Object({
    cust_id: ExternalIdSchema,
    billing_info: Type.Object({
      name: nullableString, last_name: nullableString,
      identification: Type.Optional(Type.Object({ type: Type.String(), number: Type.String() }, object)),
    }, object),
  }, object),
  seller: Type.Object({ cust_id: ExternalIdSchema }, object),
}, object);

export const MeliBuyerProfileSchema = Type.Object({
  id: ExternalIdSchema, first_name: nullableString, last_name: nullableString,
  email: nullableString, phone,
  identification: Type.Optional(Type.Union([Type.Object({ type: Type.String(), number: Type.String() }, object), Type.Null()])),
}, object);

export const MeliNotificationSchema = Type.Object({
  resource: Type.String({ pattern: '^/orders/[1-9][0-9]*$' }), topic: Type.Literal('orders_v2'),
  user_id: ExternalIdSchema, application_id: ExternalIdSchema,
  attempts: Type.Optional(Type.Integer({ minimum: 1 })), sent: Type.Optional(Type.String()), received: Type.Optional(Type.String()),
}, object);

export const MeliIdentitySchema = Type.Object({
  id: ExternalIdSchema, site_id: Type.String(), tags: Type.Array(Type.String()),
}, object);

export type MeliOrder = Static<typeof MeliOrderSchema>;
export type MeliShipment = Static<typeof MeliShipmentSchema>;
export type MeliBillingInfo = Static<typeof MeliBillingInfoSchema>;
export type MeliBuyerProfile = Static<typeof MeliBuyerProfileSchema>;
export type MeliNotification = Static<typeof MeliNotificationSchema>;

export function decoder<T extends TSchema>(schema: T) {
  const validator = TypeCompiler.Compile(schema);
  return (value: unknown): Static<T> => {
    if (!validator.Check(value)) throw new AdapterError('ADAPTER_INVALID_PAYLOAD', 'Recurso Mercado Livre incompatível com o contrato de leitura.');
    return value;
  };
}

export const decodeMeliOrder = decoder(MeliOrderSchema);
export const decodeMeliShipment = decoder(MeliShipmentSchema);
export const decodeMeliBillingInfo = decoder(MeliBillingInfoSchema);
export const decodeMeliBuyerProfile = decoder(MeliBuyerProfileSchema);
export const decodeMeliNotification = decoder(MeliNotificationSchema);
export const decodeMeliIdentity = decoder(MeliIdentitySchema);

/** IDs numéricos inseguros são rejeitados em vez de serem silenciosamente arredondados. */
export function externalId(value: unknown): string {
  if (typeof value === 'string' && /^[1-9][0-9]{0,99}$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  throw new AdapterError('ADAPTER_INVALID_PAYLOAD', 'Identificador externo inválido ou sem precisão segura.');
}
