/** Operator-only local PoC transport; redirects and browser-supplied URLs are forbidden. */
export function approvedErpOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1','localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('ERP target must be an approved loopback HTTP origin');
  return `http://127.0.0.1:${url.port || '80'}`;
}
