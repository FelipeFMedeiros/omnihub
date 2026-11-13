import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { loadSecurityEnv, SITEVERIFY_URL, type SecurityConfig } from '../config/security';
import { HubError } from '../errors';

export type SiteverifyFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface ChallengeContext { readonly action: string; readonly cdata?: string }
export type TurnstileVerifier = (token: string, remoteIp?: string, context?: ChallengeContext) => Promise<boolean>;

export function createTurnstileVerifier(config: SecurityConfig, transport: SiteverifyFetch = fetch): TurnstileVerifier {
  // Siteverify tem convergência eventual de reuso. A PoC de processo único
  // reivindica o digest antes do HTTP; jamais armazena o token bruto.
  const redeemed = new Map<string, number>();
  let nextSweep = 0;
  return async (token, remoteIp, context) => {
    if (!token || token.length > 2048) return false;
    if (!config.turnstileDummy) {
      const now = Date.now();
      if (now >= nextSweep) {
        for (const [key, expiry] of redeemed) if (expiry <= now) redeemed.delete(key);
        nextSweep = now + 1000;
      }
      const digest = createHash('sha256').update(token).digest('hex');
      if ((redeemed.get(digest) ?? 0) > now || redeemed.size >= 10000) return false;
      redeemed.set(digest, now + 300000);
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const body = new URLSearchParams({ secret: config.turnstileSecret, response: token });
      if (remoteIp && isIP(remoteIp)) body.set('remoteip', remoteIp);
      const operation = async () => {
        const response = await transport(SITEVERIFY_URL, { method: 'POST', body, signal: controller.signal, redirect: 'error' });
        if (!response.ok) { await response.body?.cancel(); return false; }
        const result: unknown = await response.json();
        if (!result || typeof result !== 'object' || !('success' in result) || result.success !== true) return false;
        if (!('hostname' in result) || typeof result.hostname !== 'string') return false;
        // As chaves de teste não atestam hostname, action, cdata ou horário reais.
        if (config.turnstileDummy) return !config.production && result.hostname === 'example.com';
        if (!config.turnstileHostnames.includes(result.hostname)) return false;
        if (!('challenge_ts' in result) || typeof result.challenge_ts !== 'string') return false;
        const age = Date.now() - Date.parse(result.challenge_ts);
        if (!Number.isFinite(age) || age < -30000 || age > 300000) return false;
        if (context && (!('action' in result) || result.action !== context.action)) return false;
        if (context?.cdata && (!('cdata' in result) || result.cdata !== context.cdata)) return false;
        return true;
      };
      return await Promise.race([operation(), new Promise<boolean>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve(false); }, config.turnstileTimeoutMs);
      })]);
    } catch { return false; }
    finally { if (timer) clearTimeout(timer); }
  };
}

let defaultVerifier: TurnstileVerifier | undefined;
export async function verifyTurnstileToken(token: string, remoteIp?: string): Promise<boolean> {
  defaultVerifier ??= createTurnstileVerifier(loadSecurityEnv());
  return defaultVerifier(token, remoteIp);
}

export async function requireTurnstile(verifier: TurnstileVerifier, token: string | undefined, ip: string, context: ChallengeContext) {
  if (!await verifier(token ?? '', ip, context)) throw new HubError(403, 'TURNSTILE_CHALLENGE_FAILED', 'Desafio inválido ou expirado. Solicite um novo desafio.');
}
