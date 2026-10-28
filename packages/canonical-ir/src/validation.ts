import { TypeCompiler } from '@sinclair/typebox/compiler';
import type { CanonicalOrder } from './order';
import { CanonicalOrderSchema } from './schemas';

const orderValidator = TypeCompiler.Compile(CanonicalOrderSchema);

/** Valida estrutura e soma monetária, sem converter ou alterar o payload. */
export function isCanonicalOrder(value: unknown): value is CanonicalOrder {
  if (!orderValidator.Check(value)) return false;
  let total = 0;
  for (const item of value.items) {
    const subtotal = item.unitPriceCents * item.quantity;
    total += subtotal;
    if (!Number.isSafeInteger(subtotal) || !Number.isSafeInteger(total)) return false;
  }
  return total === value.totalAmountCents;
}
