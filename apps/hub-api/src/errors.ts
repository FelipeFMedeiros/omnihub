export class HubError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 415 | 422 | 429 | 501 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HubError';
  }
}
