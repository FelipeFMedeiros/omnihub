export class HubError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HubError';
  }
}
