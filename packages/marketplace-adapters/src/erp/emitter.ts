import { Type } from '@sinclair/typebox';
import { isCanonicalOrder, type CanonicalOrder } from '@omnihub/canonical-ir';
import { AdapterError } from '../errors';
import { decoder } from '../mercadolivre/schemas';

export const LegacyErpOrderSchema = Type.Object({
  codigo_pedido: Type.String({ minLength: 1, maxLength: 200 }), origem_canal: Type.String({ minLength: 1 }),
  documento_cliente: Type.String({ pattern: '^(?:[0-9]{11}|[0-9]{14})$' }),
  cep_entrega: Type.String({ pattern: '^[0-9]{8}$' }), uf_entrega: Type.String({ pattern: '^[A-Z]{2}$' }),
  valor_total: Type.Number({ minimum: 0 }),
  itens_pedido: Type.Array(Type.Object({ codigo_sku: Type.String({ minLength: 1, maxLength: 100 }), quantidade: Type.Integer({ minimum: 1, maximum: 2147483647 }), preco_unitario: Type.Number({ minimum: 0 }) }, { additionalProperties: false }), { minItems: 1 }),
}, { additionalProperties: false });
const decode = decoder(LegacyErpOrderSchema);
export type LegacyErpOrderPayload = ReturnType<typeof decode>;
export function decodeLegacyErpOrder(value: unknown): LegacyErpOrderPayload {
  const order = decode(value);
  const cents = (n: number) => Math.round(n * 100);
  const total = order.itens_pedido.reduce((sum, line) => sum + cents(line.preco_unitario) * line.quantidade, 0);
  if (!Number.isSafeInteger(total) || total !== cents(order.valor_total)) throw new AdapterError('IR_SEMANTIC_VALIDATION_ERROR', 'Total legado incompatível com os itens.');
  return order;
}
export function emitCanonicalOrderToLegacyErp(order: CanonicalOrder): LegacyErpOrderPayload {
  if (!isCanonicalOrder(order)) throw new AdapterError('IR_SEMANTIC_VALIDATION_ERROR', 'IR inválida para emissão.');
  return decodeLegacyErpOrder({
    codigo_pedido: `${order.source}-${order.externalOrderId}`, origem_canal: order.source,
    documento_cliente: order.customer.documentNumber, cep_entrega: order.shippingAddress.postalCode,
    uf_entrega: order.shippingAddress.state, valor_total: Number((order.totalAmountCents / 100).toFixed(2)),
    itens_pedido: order.items.map(item => ({ codigo_sku: item.sku, quantidade: item.quantity, preco_unitario: Number((item.unitPriceCents / 100).toFixed(2)) })),
  });
}
