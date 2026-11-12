import { createMeliAuthorization, MeliClient, validateMeliCallback, type MeliAuthorizationAttempt } from '@omnihub/marketplace-adapters';
import { HubError } from '../errors';
export class OAuthService {
  private readonly attempts = new Map<string, MeliAuthorizationAttempt>();
  constructor(private readonly client: MeliClient, private readonly settings: { clientId: string; redirectUri: string; pkce: boolean }) {}
  start() {
    for (const [key, attempt] of this.attempts) if (attempt.expiresAt <= Date.now()) this.attempts.delete(key);
    if (this.attempts.size >= 20) throw new HubError(503, 'OAUTH_CAPACITY', 'Aguarde expirar uma tentativa OAuth.');
    const auth = createMeliAuthorization(this.settings); this.attempts.set(auth.attempt.state, auth.attempt);
    return { authorizationUrl: auth.url, expiresAt: new Date(auth.attempt.expiresAt).toISOString() };
  }
  async callback(requestUrl: string) {
    const incoming = new URL(requestUrl), state = incoming.searchParams.get('state');
    const attempt = state ? this.attempts.get(state) : undefined;
    if (!attempt) throw new HubError(400, 'OAUTH_STATE_INVALID', 'Retorno OAuth inválido ou expirado.');
    const callback = new URL(this.settings.redirectUri); callback.search = incoming.search;
    validateMeliCallback(callback.toString(), attempt);
    this.attempts.delete(attempt.state);
    await this.client.exchangeAuthorizationCode(callback.toString(), attempt);
    return { authorized: true };
  }
}
