import { isIP } from 'node:net';

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const DUMMY_SECRETS = new Set([
  '1x0000000000000000000000000000000AA',
  '2x0000000000000000000000000000000AA',
  '3x0000000000000000000000000000000AA',
]);
export interface SecurityConfig {
  readonly production: boolean;
  readonly publicHubUrl: string;
  readonly jwtSecret: string;
  readonly issuer: string;
  readonly audience: string;
  readonly sessionTtlSeconds: number;
  readonly turnstileSecret: string;
  readonly turnstileDummy: boolean;
  readonly turnstileHostnames: readonly string[];
  readonly turnstileTimeoutMs: number;
  readonly trustedProxyIps: readonly string[];
  readonly trustedProxyHeader: 'cf-connecting-ip' | 'x-forwarded-for';
}
export const isLoopback = (hostname: string) => ['localhost', '127.0.0.1', '[::1]', '::1', '::ffff:127.0.0.1'].includes(hostname);

/** PUBLIC_HUB_URL, e não X-Forwarded-Proto, determina Secure atrás do túnel. */
export function loadSecurityEnv(env: NodeJS.ProcessEnv = process.env): SecurityConfig {
  const production = env.NODE_ENV === 'production';
  let publicUrl: URL;
  try { publicUrl = new URL(env.PUBLIC_HUB_URL ?? 'http://localhost:3000'); }
  catch { throw new Error('PUBLIC_HUB_URL inválida.'); }
  if (publicUrl.origin !== (env.PUBLIC_HUB_URL ?? 'http://localhost:3000') || publicUrl.username || publicUrl.password ||
      !(publicUrl.protocol === 'https:' || (!production && publicUrl.protocol === 'http:' && isLoopback(publicUrl.hostname)))) {
    throw new Error('PUBLIC_HUB_URL exige HTTPS; HTTP somente em loopback fora de produção.');
  }
  const jwtSecret = env.JWT_SECRET ?? '';
  if (Buffer.byteLength(jwtSecret) < 32 || /SUBSTITUIR|PLACEHOLDER/i.test(jwtSecret)) throw new Error('JWT_SECRET exige segredo privado com ao menos 32 bytes.');
  const turnstileSecret = env.CLOUDFLARE_TURNSTILE_SECRET_KEY ?? '';
  if (!turnstileSecret || /SUBSTITUIR|PLACEHOLDER/i.test(turnstileSecret)) throw new Error('Configure CLOUDFLARE_TURNSTILE_SECRET_KEY.');
  const turnstileDummy = DUMMY_SECRETS.has(turnstileSecret);
  if (production && (turnstileDummy || /^[123]x0{10,}[A-Z]{2}$/.test(env.VITE_TURNSTILE_SITE_KEY ?? ''))) throw new Error('Turnstile dummy proibido em produção.');
  if (env.CLOUDFLARE_TURNSTILE_VERIFY_URL && env.CLOUDFLARE_TURNSTILE_VERIFY_URL !== SITEVERIFY_URL) throw new Error('Siteverify deve usar o endpoint oficial.');
  const sessionTtlSeconds = Number(env.AUTH_SESSION_TTL_SECONDS ?? 3600);
  const turnstileTimeoutMs = Number(env.TURNSTILE_TIMEOUT_MS ?? 5000);
  if (!Number.isInteger(sessionTtlSeconds) || sessionTtlSeconds < 60 || sessionTtlSeconds > 3600) throw new Error('Sessão exige duração de 60 a 3600 segundos.');
  if (!Number.isInteger(turnstileTimeoutMs) || turnstileTimeoutMs < 100 || turnstileTimeoutMs > 10000) throw new Error('Timeout Turnstile inválido.');
  const turnstileHostnames = (env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map(origin => {
    const url = new URL(origin.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.origin !== origin.trim() || url.username || url.password || (production && url.protocol !== 'https:')) throw new Error('Origens de autenticação inválidas.');
    return url.hostname;
  });
  const trustedProxyIps = (env.TRUSTED_PROXY_IPS ?? '').split(',').map(ip => ip.trim()).filter(Boolean);
  if (trustedProxyIps.some(ip => !isIP(ip))) throw new Error('TRUSTED_PROXY_IPS exige endereços IP exatos.');
  const trustedProxyHeader = env.TRUSTED_PROXY_HEADER ?? 'cf-connecting-ip';
  if (!['cf-connecting-ip', 'x-forwarded-for'].includes(trustedProxyHeader)) throw new Error('TRUSTED_PROXY_HEADER inválido.');
  return {
    production, publicHubUrl: publicUrl.origin, jwtSecret, issuer: publicUrl.origin,
    audience: 'omnihub-account', sessionTtlSeconds, turnstileSecret, turnstileDummy,
    turnstileHostnames, turnstileTimeoutMs, trustedProxyIps,
    trustedProxyHeader: trustedProxyHeader as SecurityConfig['trustedProxyHeader'],
  };
}
