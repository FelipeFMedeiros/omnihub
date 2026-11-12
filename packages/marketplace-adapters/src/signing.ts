import { createHmac, timingSafeEqual } from 'node:crypto';
export function signInternalBody(raw: string, secret: string): string { return createHmac('sha256', secret).update(raw).digest('hex'); }
export function verifyInternalBody(raw: string, secret: string, signature: string | null): boolean {
  if (secret.length < 32 || !signature || !/^[a-f0-9]{64}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signInternalBody(raw, secret), 'hex'), Buffer.from(signature, 'hex'));
}
