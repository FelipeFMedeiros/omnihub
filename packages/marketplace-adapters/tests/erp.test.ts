import { expect, test } from 'bun:test';
import { decodeLegacyErpOrder, emitCanonicalOrderToLegacyErp, MeliClient, parseMeliOrderToCanonical, signInternalBody, verifyInternalBody } from '../src';
import legacy from './fixtures/meli-order-legacy.json';
test('emissor ERP traduz centavos sem alterar IR, com chave idempotente estável', () => {
  const order = parseMeliOrderToCanonical({ order: legacy }, { canonicalOrderId: crypto.randomUUID(), expectedSellerId: '900000001', skuMappings: [{ itemId: 'MLB1234567890', sku: 'SKU' }] });
  const before = structuredClone(order), result = emitCanonicalOrderToLegacyErp(order);
  expect(result.valor_total).toBe(39.98); expect(result.itens_pedido[0]?.preco_unitario).toBe(19.99);
  expect(result.codigo_pedido).toBe('MERCADO_LIVRE-2000000000000001'); expect(order).toEqual(before);
  expect(() => decodeLegacyErpOrder({ ...result, valor_total: 1 })).toThrow();
});
test('HMAC interno é validado nos bytes exatos e rejeita prefixos/comprimentos inválidos', () => {
  const secret = 'test-local-secret-'.repeat(3), raw = '{"a":1}';
  expect(verifyInternalBody(raw, secret, signInternalBody(raw, secret))).toBe(true);
  for (const sig of [null, 'bad', 'f'.repeat(64), 'f'.repeat(65)]) expect(verifyInternalBody(raw, secret, sig)).toBe(false);
  expect(verifyInternalBody(raw+' ', secret, signInternalBody(raw, secret))).toBe(false);
});
test('emissor de saldo usa PUT absoluto e verifica usuário, dono e variação', async () => {
  const requests: Request[] = [];
  const client = new MeliClient({ clientId: '123456', clientSecret: 'test-only-secret', expectedSellerId: '900000001', initialTokens: { accessToken: 'test-access', refreshToken: 'test-refresh', userId: '900000001', expiresAt: Date.now()+3600000 },
    transport: async r => { requests.push(r); if (r.url.endsWith('/users/me')) return Response.json({ id: 900000001, site_id: 'MLB', tags: ['test_user'] }); if (r.method === 'GET') return Response.json({ id: 'MLB123', seller_id: 900000001 }); return Response.json({}); },
  });
  await client.updateStock('MLB123', '12345', 4);
  expect(requests.at(-1)?.url).toBe('https://api.mercadolibre.com/items/MLB123/variations/12345'); expect(requests.at(-1)?.method).toBe('PUT');
  expect(await requests.at(-1)!.json()).toEqual({ available_quantity: 4 });
});
test('criacao explicita de usuario de teste usa MLB e nao repete POST em falha ambigua', async () => {
  let calls=0;
  const client = new MeliClient({clientId:'123456',clientSecret:'test-only-secret',initialTokens:{accessToken:'test-access',refreshToken:'test-refresh',userId:'900000001',expiresAt:Date.now()+3600000},transport:async request=>{
    calls++;expect(request.method).toBe('POST');expect(request.url).toBe('https://api.mercadolibre.com/users/test_user');expect(await request.json()).toEqual({site_id:'MLB'});return Response.json({}, {status:503});
  }});
  await expect(client.createTestUser()).rejects.toMatchObject({code:'MELI_HTTP_ERROR'});expect(calls).toBe(1);
});
test('publicação de saldo é bloqueada para conta sem marca de teste antes de consultar anúncio',async()=>{
  let calls=0;
  const client=new MeliClient({clientId:'123456',clientSecret:'test-only-secret',expectedSellerId:'900000001',initialTokens:{accessToken:'test-access',refreshToken:'test-refresh',userId:'900000001',expiresAt:Date.now()+3600000},transport:async()=>{calls++;return Response.json({id:900000001,site_id:'MLB',tags:[]});}});
  await expect(client.updateStock('MLB123','',1)).rejects.toMatchObject({code:'ADAPTER_RESOURCE_MISMATCH'});expect(calls).toBe(1);
});
