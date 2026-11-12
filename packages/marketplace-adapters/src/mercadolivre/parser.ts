import { isCanonicalOrder, type CanonicalOrder, type CanonicalOrderStatus } from '@omnihub/canonical-ir';
import { AdapterError } from '../errors';
import type { OrderParseContext, SpokeAdapter } from '../types';
import { decodeMeliBillingInfo, decodeMeliBuyerProfile, decodeMeliNotification, decodeMeliOrder, decodeMeliShipment, externalId } from './schemas';

export interface MeliOrderInput {
  readonly order: unknown;
  readonly shipment?: unknown;
  readonly billingInfo?: unknown;
  /** Somente recurso autorizado do comprador correspondente; nunca defaults sintéticos. */
  readonly buyerProfile?: unknown;
}
export interface MeliSkuMapping {
  readonly itemId: string;
  readonly variationId?: string;
  readonly sku: string;
}
export interface MeliParseContext extends OrderParseContext {
  readonly expectedSellerId: string;
  readonly skuMappings: readonly MeliSkuMapping[];
}

const statuses: Readonly<Record<string, CanonicalOrderStatus>> = {
  paid: 'PAID', confirmed: 'PENDING', payment_required: 'PENDING',
  payment_in_process: 'PENDING', partially_paid: 'PENDING', cancelled: 'CANCELLED',
};
function required(value: string | null | undefined): string {
  if (!value?.trim() || /^(?:x{3,}|\*+|masked|redacted)$/i.test(value.trim())) {
    throw new AdapterError('ADAPTER_ENRICHMENT_REQUIRED', 'Dados autorizados insuficientes para representar o pedido na IR atual.');
  }
  return value.trim();
}
function cents(value: string | number): number {
  const amount = Number(value);
  const result = Math.round(amount * 100);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(result)) {
    throw new AdapterError('IR_SEMANTIC_VALIDATION_ERROR', 'Valor monetário fora dos limites canônicos.');
  }
  return result;
}
function createdAt(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match) throw new AdapterError('ADAPTER_INVALID_PAYLOAD', 'Data do pedido deve informar horário e fuso válidos.');
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) {
    throw new AdapterError('ADAPTER_INVALID_PAYLOAD', 'Data do pedido inválida.');
  }
  return date;
}
function mismatch(): never {
  throw new AdapterError('ADAPTER_RESOURCE_MISMATCH', 'Recursos não pertencem ao mesmo pedido, comprador ou vendedor.');
}

export function parseMeliOrderToCanonical(input: MeliOrderInput, context: MeliParseContext): CanonicalOrder {
  const order = decodeMeliOrder(input.order);
  if (externalId(order.seller.id) !== externalId(context.expectedSellerId)) mismatch();
  if (order.currency_id !== 'BRL' || (order.context?.site && order.context.site !== 'MLB')) {
    throw new AdapterError('ADAPTER_UNSUPPORTED_ORDER', 'Esta versão do adaptador suporta somente pedidos brasileiros em BRL.');
  }
  const status = Object.hasOwn(statuses, order.status) ? statuses[order.status] : undefined;
  if (!status) throw new AdapterError('ADAPTER_UNSUPPORTED_ORDER', 'Estado do pedido sem representação canônica suportada.');

  const buyerId = externalId(order.buyer.id);
  const shipment = input.shipment === undefined ? undefined : decodeMeliShipment(input.shipment);
  if (shipment && (!order.shipping?.id || externalId(shipment.id) !== externalId(order.shipping.id) || externalId(shipment.destination.receiver_id) !== buyerId)) mismatch();
  const billing = input.billingInfo === undefined ? undefined : decodeMeliBillingInfo(input.billingInfo);
  if (billing && (externalId(billing.buyer.cust_id) !== buyerId || externalId(billing.seller.cust_id) !== externalId(order.seller.id))) mismatch();
  const profile = input.buyerProfile === undefined ? undefined : decodeMeliBuyerProfile(input.buyerProfile);
  if (profile && externalId(profile.id) !== buyerId) mismatch();

  const address = shipment?.destination.shipping_address ?? order.shipping?.receiver_address;
  if (!address) throw new AdapterError('ADAPTER_ENRICHMENT_REQUIRED', 'Endereço de entrega não disponível para a IR atual.');
  if (address.country && address.country.id !== 'BR') throw new AdapterError('ADAPTER_UNSUPPORTED_ORDER', 'Endereço fora do recorte brasileiro.');
  const identification = billing?.buyer.billing_info.identification ?? profile?.identification;
  const documentType = identification?.type ?? order.buyer.billing_info?.doc_type;
  if (documentType && !['CPF', 'CNPJ'].includes(documentType)) throw new AdapterError('ADAPTER_UNSUPPORTED_ORDER', 'Documento sem representação no recorte brasileiro.');
  const documentNumber = required(identification?.number ?? order.buyer.billing_info?.doc_number).replace(/\D/g, '');
  if ((documentType === 'CPF' && documentNumber.length !== 11) || (documentType === 'CNPJ' && documentNumber.length !== 14)) {
    throw new AdapterError('IR_SEMANTIC_VALIDATION_ERROR', 'Documento incompatível com o tipo informado.');
  }

  const mappings = new Map<string, string>();
  for (const mapping of context.skuMappings) {
    if (!/^MLB[0-9]+$/.test(mapping.itemId) || !mapping.sku.trim() || mapping.sku !== mapping.sku.trim()) {
      throw new AdapterError('ADAPTER_INVALID_CONTEXT', 'Mapeamento canônico inválido.');
    }
    const key = `${mapping.itemId}:${mapping.variationId === undefined ? '' : externalId(mapping.variationId)}`;
    if (mappings.has(key)) throw new AdapterError('ADAPTER_INVALID_CONTEXT', 'Mapeamento canônico ambíguo.');
    mappings.set(key, mapping.sku);
  }
  const items = order.order_items.map(line => {
    const key = `${line.item.id}:${line.item.variation_id == null ? '' : externalId(line.item.variation_id)}`;
    const sku = mappings.get(key);
    if (!sku) throw new AdapterError('UNMAPPED_SPOKE_SKU', 'Item/variação sem mapeamento canônico ativo.');
    if (line.currency_id && line.currency_id !== order.currency_id) throw new AdapterError('ADAPTER_UNSUPPORTED_ORDER', 'Moedas divergentes no pedido.');
    return { sku, externalItemId: line.item.id, title: line.item.title.trim(), unitPriceCents: cents(line.unit_price), quantity: line.quantity, currency: order.currency_id };
  });
  const billingName = billing?.buyer.billing_info;
  const name = billingName?.name?.trim()
    ? [billingName.name, billingName.last_name].filter(Boolean).join(' ').trim()
    : [profile?.first_name ?? order.buyer.first_name, profile?.last_name ?? order.buyer.last_name].filter(Boolean).join(' ').trim();
  const buyerPhone = profile?.phone ?? order.buyer.phone;
  const phone = shipment?.destination.receiver_phone?.trim() || (buyerPhone?.number ? `${buyerPhone.area_code ?? ''}${buyerPhone.number}`.trim() : undefined);
  const canonical: CanonicalOrder = {
    id: context.canonicalOrderId, source: 'MERCADO_LIVRE', externalOrderId: externalId(order.id),
    createdAt: createdAt(order.date_created), status, totalAmountCents: cents(order.total_amount),
    customer: {
      externalCustomerId: buyerId, documentNumber, name: required(name),
      email: required(profile?.email ?? order.buyer.email), ...(phone ? { phone } : {}),
    },
    shippingAddress: {
      street: required(address.street_name), number: required(address.street_number == null ? undefined : String(address.street_number)),
      neighborhood: required(address.neighborhood?.name), city: required(address.city?.name),
      state: required(address.state?.id).replace(/^BR-/i, '').toUpperCase(), postalCode: required(address.zip_code).replace(/\D/g, ''),
      ...(address.comment?.trim() ? { complement: address.comment.trim() } : {}),
    }, items,
  };
  if (!isCanonicalOrder(canonical)) throw new AdapterError('IR_SEMANTIC_VALIDATION_ERROR', 'Pedido incompatível com a IR; confira dados obrigatórios, totais, frete e descontos.');
  return canonical;
}

/** A notificação é um aviso não confiável; nenhum recurso arbitrário é retornado. */
export function parseMeliOrderNotification(raw: unknown, expected: { applicationId: string; sellerId: string }): { orderId: string } {
  const notification = decodeMeliNotification(raw);
  if (externalId(notification.application_id) !== externalId(expected.applicationId) || externalId(notification.user_id) !== externalId(expected.sellerId)) mismatch();
  return { orderId: externalId(notification.resource.slice('/orders/'.length)) };
}

export const meliAdapter: SpokeAdapter<MeliOrderInput, MeliParseContext> = {
  source: 'MERCADO_LIVRE', parseOrderToCanonical: parseMeliOrderToCanonical,
};
