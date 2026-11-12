import { Type } from '@sinclair/typebox';
import { AdapterError } from '../errors';
import { validateMeliCallback, type MeliAuthorizationAttempt } from './oauth';
import { decoder, decodeMeliBillingInfo, decodeMeliIdentity, decodeMeliOrder, decodeMeliShipment, externalId } from './schemas';
import { parseMeliOrderNotification, type MeliOrderInput } from './parser';

const decodeTokenResponse = decoder(Type.Object({
  access_token: Type.String({ minLength: 1 }), refresh_token: Type.String({ minLength: 1 }),
  token_type: Type.String({ pattern: '^[Bb][Ee][Aa][Rr][Ee][Rr]$' }), expires_in: Type.Integer({ minimum: 1, maximum: 31_536_000 }),
  user_id: Type.Union([Type.String({ pattern: '^[1-9][0-9]*$' }), Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })]),
}, { additionalProperties: true }));
const decodeStoredTokens = decoder(Type.Object({
  accessToken: Type.String({ minLength: 1 }), refreshToken: Type.String({ minLength: 1 }),
  userId: Type.String({ pattern: '^[1-9][0-9]*$', maxLength: 100 }), expiresAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
}, { additionalProperties: false }));

export interface MeliTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly userId: string;
  readonly expiresAt: number;
}
export interface MeliClientOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly expectedSellerId?: string;
  readonly refreshToken?: string;
  readonly initialTokens?: MeliTokens;
  /** Deve persistir a rotação antes que o token novo seja usado. */
  readonly onTokens?: (tokens: MeliTokens) => Promise<void>;
  readonly transport?: (request: Request) => Promise<Response>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly timeoutMs?: number;
}

const HTTP_ERROR = 'Não foi possível concluir a chamada Mercado Livre; confira status e permissões.';
function invalidResponse(): never { throw new AdapterError('MELI_INVALID_RESPONSE', 'Resposta externa incompatível com o contrato de leitura.', 502); }

async function readJson(response: Response): Promise<unknown> {
  if (!response.body) return invalidResponse();
  const maxBytes = 2 * 1024 * 1024;
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); return invalidResponse(); }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
    catch { return invalidResponse(); }
  } finally { reader.releaseLock(); }
}

export class MeliClient {
  #options: MeliClientOptions;
  #tokens?: MeliTokens;
  #refreshing?: Promise<MeliTokens>;
  #now: () => number;
  #transport: (request: Request) => Promise<Response>;
  #sleep: (ms: number) => Promise<void>;
  #timeoutMs: number;

  constructor(options: MeliClientOptions) {
    externalId(options.clientId);
    if (!options.clientSecret.trim() || /SUBSTITUIR/i.test(options.clientSecret)) throw new AdapterError('MELI_INVALID_CONFIGURATION', 'Configure as credenciais privadas da aplicação.', 400);
    if (options.expectedSellerId !== undefined) externalId(options.expectedSellerId);
    this.#options = { ...options };
    this.#now = options.now ?? Date.now;
    this.#transport = options.transport ?? (request => fetch(request));
    this.#sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 60_000) throw new AdapterError('MELI_INVALID_CONFIGURATION', 'Timeout deve estar entre 1 e 60000 ms.', 400);
    if (options.initialTokens) {
      this.#tokens = { ...decodeStoredTokens(options.initialTokens) };
      this.#checkOwner(this.#tokens.userId);
    }
  }

  #checkOwner(userId: string) {
    if (this.#options.expectedSellerId && userId !== this.#options.expectedSellerId) throw new AdapterError('ADAPTER_RESOURCE_MISMATCH', 'Autorização não corresponde ao vendedor configurado.', 403);
  }

  async #request(path: string, accessToken?: string, form?: URLSearchParams): Promise<{ status: number; body: unknown }> {
    const retryable = form === undefined;
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      let waitMs = 0;
      try {
        const response = await this.#transport(new Request(`https://api.mercadolibre.com${path}`, {
          method: form ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
          headers: {
            Accept: 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
            ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
            ...(path.startsWith('/shipments/') ? { 'x-format-new': 'true' } : {}),
          }, ...(form ? { body: form.toString() } : {}),
        }));
        if (response.ok) return { status: response.status, body: await readJson(response) };
        await response.body?.cancel();
        if (!retryable || attempt >= 2 || (response.status !== 429 && response.status < 500)) return { status: response.status, body: undefined };
        const retryAfter = response.headers.get('Retry-After');
        if (retryAfter) {
          const seconds = Number(retryAfter);
          waitMs = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(retryAfter) - this.#now());
          // Não retentar cedo quando o servidor pede uma espera fora do orçamento local.
          if (!Number.isFinite(waitMs) || waitMs > 5000) return { status: response.status, body: undefined };
        } else waitMs = 200 * 2 ** attempt + Math.floor((this.#options.random ?? Math.random)() * 100);
      } catch (error) {
        if (error instanceof AdapterError) throw error;
        if (!retryable || attempt >= 2) throw new AdapterError('MELI_NETWORK_ERROR', 'Falha ou timeout na comunicação externa.', 503);
        waitMs = 200 * 2 ** attempt + Math.floor((this.#options.random ?? Math.random)() * 100);
      } finally { clearTimeout(timer); }
      await this.#sleep(waitMs);
    }
  }

  async #grant(form: URLSearchParams): Promise<MeliTokens> {
    const result = await this.#request('/oauth/token', undefined, form);
    if (result.status < 200 || result.status >= 300) throw new AdapterError('MELI_HTTP_ERROR', HTTP_ERROR, result.status);
    let raw: ReturnType<typeof decodeTokenResponse>;
    try { raw = decodeTokenResponse(result.body); } catch { return invalidResponse(); }
    const tokens: MeliTokens = {
      accessToken: raw.access_token, refreshToken: raw.refresh_token,
      userId: externalId(raw.user_id), expiresAt: this.#now() + raw.expires_in * 1000,
    };
    this.#checkOwner(tokens.userId);
    try { await this.#options.onTokens?.({ ...tokens }); }
    catch { throw new AdapterError('MELI_TOKEN_PERSISTENCE_FAILED', 'Não foi possível persistir a rotação de credenciais; refaça a autorização se necessário.', 503); }
    this.#tokens = tokens;
    return { ...tokens };
  }

  #credentialForm(grant: string): URLSearchParams {
    return new URLSearchParams({ grant_type: grant, client_id: this.#options.clientId, client_secret: this.#options.clientSecret });
  }

  async exchangeAuthorizationCode(callbackUrl: string, attempt: MeliAuthorizationAttempt): Promise<MeliTokens> {
    if (attempt.clientId !== this.#options.clientId) throw new AdapterError('MELI_OAUTH_CALLBACK_REJECTED', 'Autorização pertence a outra aplicação.', 400);
    const code = validateMeliCallback(callbackUrl, attempt, this.#now());
    const form = this.#credentialForm('authorization_code');
    form.set('code', code); form.set('redirect_uri', attempt.redirectUri);
    if (attempt.codeVerifier) form.set('code_verifier', attempt.codeVerifier);
    return this.#grant(form);
  }

  async #refresh(): Promise<MeliTokens> {
    if (this.#refreshing) return this.#refreshing;
    const refreshToken = this.#tokens?.refreshToken ?? this.#options.refreshToken;
    if (!refreshToken?.trim() || /SUBSTITUIR/i.test(refreshToken)) throw new AdapterError('MELI_INVALID_CONFIGURATION', 'Autorize a aplicação antes de executar a consulta externa.', 400);
    const form = this.#credentialForm('refresh_token'); form.set('refresh_token', refreshToken);
    const pending = this.#grant(form); this.#refreshing = pending;
    try { return await pending; } finally { this.#refreshing = undefined; }
  }

  async #get(path: string): Promise<unknown> {
    let tokens = this.#tokens;
    if (!tokens || tokens.expiresAt <= this.#now() + 30_000) tokens = await this.#refresh();
    let result = await this.#request(path, tokens.accessToken);
    if (result.status === 401) {
      const latest = this.#tokens;
      const replacement = latest && latest.accessToken !== tokens.accessToken ? latest : await this.#refresh();
      result = await this.#request(path, replacement.accessToken);
    }
    if (result.status < 200 || result.status >= 300) throw new AdapterError('MELI_HTTP_ERROR', HTTP_ERROR, result.status);
    return result.body;
  }

  async getCurrentUser(): Promise<{ id: string; siteId: string; isTestUser: boolean }> {
    const raw = await this.#get('/users/me');
    try {
      const user = decodeMeliIdentity(raw);
      this.#checkOwner(externalId(user.id));
      return { id: externalId(user.id), siteId: user.site_id, isTestUser: user.tags.includes('test_user') };
    } catch (error) { if (error instanceof AdapterError && error.code === 'ADAPTER_RESOURCE_MISMATCH') throw error; return invalidResponse(); }
  }

  async getOrder(id: string) {
    if (!this.#options.expectedSellerId) throw new AdapterError('MELI_INVALID_CONFIGURATION', 'Configure o vendedor esperado para consultar pedidos.', 400);
    const orderId = externalId(id);
    const raw = await this.#get(`/orders/${orderId}`);
    let order: ReturnType<typeof decodeMeliOrder>;
    try { order = decodeMeliOrder(raw); } catch { return invalidResponse(); }
    if (externalId(order.id) !== orderId || externalId(order.seller.id) !== this.#options.expectedSellerId) throw new AdapterError('ADAPTER_RESOURCE_MISMATCH', 'Pedido retornado não corresponde à consulta autorizada.', 403);
    return order;
  }

  async loadOrderInput(id: string): Promise<MeliOrderInput> {
    const order = await this.getOrder(id);
    let shipment: unknown, billingInfo: unknown;
    if (order.shipping?.id) shipment = await this.#get(`/shipments/${externalId(order.shipping.id)}`);
    if (order.buyer.billing_info?.id) billingInfo = await this.#get(`/orders/billing-info/MLB/${externalId(order.buyer.billing_info.id)}`);
    if (shipment !== undefined) {
      let resource: ReturnType<typeof decodeMeliShipment>;
      try { resource = decodeMeliShipment(shipment); } catch { return invalidResponse(); }
      if (externalId(resource.id) !== externalId(order.shipping?.id) || externalId(resource.destination.receiver_id) !== externalId(order.buyer.id)) {
        throw new AdapterError('ADAPTER_RESOURCE_MISMATCH', 'Entrega não corresponde ao pedido consultado.', 403);
      }
    }
    if (billingInfo !== undefined) {
      let resource: ReturnType<typeof decodeMeliBillingInfo>;
      try { resource = decodeMeliBillingInfo(billingInfo); } catch { return invalidResponse(); }
      if (externalId(resource.buyer.cust_id) !== externalId(order.buyer.id) || externalId(resource.seller.cust_id) !== externalId(order.seller.id)) {
        throw new AdapterError('ADAPTER_RESOURCE_MISMATCH', 'Faturamento não corresponde ao pedido consultado.', 403);
      }
    }
    return { order, ...(shipment === undefined ? {} : { shipment }), ...(billingInfo === undefined ? {} : { billingInfo }) };
  }

  async loadOrderNotification(raw: unknown): Promise<MeliOrderInput> {
    if (!this.#options.expectedSellerId) throw new AdapterError('MELI_INVALID_CONFIGURATION', 'Configure o vendedor esperado.', 400);
    const notification = parseMeliOrderNotification(raw, { applicationId: this.#options.clientId, sellerId: this.#options.expectedSellerId });
    return this.loadOrderInput(notification.orderId);
  }
}
