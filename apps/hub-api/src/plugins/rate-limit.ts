import { isIP } from 'node:net';
import type { SecurityConfig } from '../config/security';

type ProxyConfig = Pick<SecurityConfig, 'trustedProxyIps' | 'trustedProxyHeader'>;
const normalizeIp = (ip: string) => ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;

/** Nunca usa cabeçalhos como prova de identidade de um peer não configurado. */
export function clientIp(request: Request, peer: string | undefined, config?: ProxyConfig): string {
  const socketIp = peer && isIP(peer) ? normalizeIp(peer) : 'unknown';
  const trusted = new Set(config?.trustedProxyIps.map(normalizeIp));
  if (!trusted.has(socketIp) || !config) return socketIp;
  const raw = request.headers.get(config.trustedProxyHeader);
  if (!raw) return socketIp;
  const chain = raw.split(',').map(ip => ip.trim());
  if (chain.length > 32 || chain.some(ip => !isIP(ip)) || (config.trustedProxyHeader === 'cf-connecting-ip' && chain.length !== 1)) return socketIp;
  if (config.trustedProxyHeader === 'cf-connecting-ip') return normalizeIp(chain[0]!);
  // XFF anexado por proxies confiáveis: remove da direita até o primeiro peer não confiável.
  for (const ip of chain.reverse().map(normalizeIp)) if (!trusted.has(ip)) return ip;
  return socketIp;
}

/** Janela fixa, por processo/peer; limite de memória falha fechado para IPs novos. */
export class EdgeRateLimiter {
  private readonly buckets = new Map<string, { count: number; expiresAt: number }>();
  private nextSweep = 0;
  constructor(private readonly now: () => number = Date.now, private readonly maxKeys = 10000) {}

  consume(group: 'auth' | 'ingestion', ip: string): { allowed: boolean; retryAfter: number } {
    const now = this.now(), windowMs = group === 'auth' ? 60000 : 1000, limit = group === 'auth' ? 10 : 500;
    if (now >= this.nextSweep) {
      for (const [key, value] of this.buckets) if (value.expiresAt <= now) this.buckets.delete(key);
      this.nextSweep = now + 1000;
    }
    const key = `${group}:${ip}`;
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.expiresAt <= now) {
      if (!bucket && this.buckets.size >= this.maxKeys) return { allowed: false, retryAfter: 1 };
      bucket = { count: 0, expiresAt: now + windowMs }; this.buckets.set(key, bucket);
    }
    const allowed = bucket.count < limit;
    if (allowed) bucket.count++;
    return { allowed, retryAfter: Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000)) };
  }
}
