export type AdapterErrorCode =
  | 'ADAPTER_INVALID_PAYLOAD' | 'ADAPTER_INVALID_CONTEXT' | 'ADAPTER_ENRICHMENT_REQUIRED'
  | 'ADAPTER_RESOURCE_MISMATCH' | 'ADAPTER_UNSUPPORTED_ORDER' | 'UNMAPPED_SPOKE_SKU'
  | 'IR_SEMANTIC_VALIDATION_ERROR' | 'MELI_INVALID_CONFIGURATION' | 'MELI_OAUTH_CALLBACK_REJECTED'
  | 'MELI_NETWORK_ERROR' | 'MELI_HTTP_ERROR' | 'MELI_INVALID_RESPONSE' | 'MELI_TOKEN_PERSISTENCE_FAILED' | 'REAUTH_REQUIRED';

/** Mensagens estáticas: nunca inclui corpo externo, URL, token ou causa do fetch. */
export class AdapterError extends Error {
  constructor(readonly code: AdapterErrorCode, message: string, readonly status = 422) {
    super(message);
    this.name = 'AdapterError';
  }
}
