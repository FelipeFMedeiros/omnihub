import type { MarketplaceSource } from '@omnihub/canonical-ir';
import { decodeMeliOrder } from './mercadolivre/schemas';
/** Projeções dos snapshots já persistidos, sem reconstruir a tradução histórica. */
export function inspectRawSnapshot(source: MarketplaceSource, raw: unknown): unknown {
  if (source !== 'MERCADO_LIVRE' || !raw || typeof raw !== 'object' || !('order' in raw)) return { redacted: true };
  try {
    const order = decodeMeliOrder(raw.order);
    return { order: { id: order.id, status: order.status, date_created: order.date_created, currency_id: order.currency_id, total_amount: order.total_amount,
      buyer: { redacted: true }, seller: { redacted: true }, shipping: { redacted: true },
      order_items: order.order_items.map(i => ({ item: { id: i.item.id, variation_id: i.item.variation_id ?? null }, quantity: i.quantity, unit_price: i.unit_price })) } };
  } catch { return { redacted: true }; }
}
export function inspectCanonicalSnapshot(value: unknown): unknown {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  return { id: v.id, source: v.source, externalOrderId: v.externalOrderId, status: v.status, createdAt: v.createdAt, totalAmountCents: v.totalAmountCents,
    customer: { redacted: true }, shippingAddress: { redacted: true }, items: Array.isArray(v.items) ? v.items.map((i: unknown) => {
      const item = i as Record<string, unknown>; return { sku: item.sku, externalItemId: item.externalItemId, quantity: item.quantity, unitPriceCents: item.unitPriceCents, currency: item.currency };
    }) : [] };
}
export function inspectErpSnapshot(value: unknown): unknown {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  return { codigo_pedido: v.codigo_pedido, origem_canal: v.origem_canal, valor_total: v.valor_total, itens_pedido: v.itens_pedido, documento_cliente: '[redacted]', cep_entrega: '[redacted]', uf_entrega: '[redacted]' };
}
