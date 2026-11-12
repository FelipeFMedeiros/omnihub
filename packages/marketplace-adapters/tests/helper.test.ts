import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { AdapterError, MeliClient } from '../src';
import { loadMeliSettings, readMeliTokens, smokeMeli, writeMeliTokens } from '../scripts/meli';

const env = { MELI_APP_ID: '123456', MELI_CLIENT_SECRET: 'fake-private', MELI_TEST_SELLER_ID: '900000001', MELI_REDIRECT_URI: 'https://callback.example.invalid/oauth' };
const now = Date.now();
const tokens = { accessToken: 'fake-access', refreshToken: 'fake-refresh', userId: '900000001', expiresAt: now + 3600_000 };
test('helper valida configuração sem exigir credenciais nos testes puros', () => {
  expect(loadMeliSettings('authorize', env).pkce).toBe(true);
  expect(loadMeliSettings('authorize', { ...env, MELI_USE_PKCE: 'false' }).pkce).toBe(false);
  expect(() => loadMeliSettings('smoke', { ...env, MELI_TEST_SELLER_ID: '' })).toThrow(AdapterError);
  expect(() => loadMeliSettings('smoke', { ...env, MELI_CLIENT_SECRET: 'SUBSTITUIR' })).toThrow(AdapterError);
  expect(() => loadMeliSettings('authorize', { ...env, MELI_USE_PKCE: 'maybe' })).toThrow(AdapterError);
  expect(() => loadMeliSettings('authorize', { ...env, MELI_OAUTH_LISTEN_PORT: '0' })).toThrow(AdapterError);
  expect(loadMeliSettings('authorize', { ...env, MELI_REDIRECT_URI: 'http://127.0.0.1:3001/oauth' }).port).toBe(3001);
  expect(() => loadMeliSettings('authorize', { ...env, MELI_REDIRECT_URI: 'http://127.0.0.1:3001/oauth', MELI_OAUTH_LISTEN_PORT: '3002' })).toThrow(AdapterError);
});
test('arquivo privado grava/renova atomicamente e não mistura aplicações', async () => {
  const parent = fileURLToPath(new URL('../../../output/task-003-tests/', import.meta.url));
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'tokens-')); const path = join(directory, 'tokens.json');
  try {
    expect(await readMeliTokens(path, env.MELI_APP_ID)).toBeUndefined();
    await writeMeliTokens(path, env.MELI_APP_ID, tokens);
    expect(await readMeliTokens(path, env.MELI_APP_ID)).toEqual(tokens);
    const rotated = { ...tokens, refreshToken: 'fake-rotated' };
    await writeMeliTokens(path, env.MELI_APP_ID, rotated);
    expect(await readMeliTokens(path, env.MELI_APP_ID)).toEqual(rotated);
    expect(await readdir(directory)).toEqual(['tokens.json']);
    await expect(readMeliTokens(path, '123457')).rejects.toBeInstanceOf(AdapterError);
    expect(JSON.parse(await readFile(path, 'utf8')).clientId).toBe(env.MELI_APP_ID);
    await writeFile(path, '{invalid-fake-private');
    await expect(readMeliTokens(path, env.MELI_APP_ID)).rejects.toBeInstanceOf(AdapterError);
  } finally { await unlink(path).catch(() => {}); await rmdir(directory); }
});
test('smoke produz evidência de identidade sanitizada, sem alegar parsing', async () => {
  const client = new MeliClient({ clientId: env.MELI_APP_ID, clientSecret: env.MELI_CLIENT_SECRET, initialTokens: tokens, expectedSellerId: env.MELI_TEST_SELLER_ID,
    transport: async () => Response.json({ id: 900000001, site_id: 'MLB', tags: ['test_user'], email: 'private@example.invalid' }),
  });
  const result = await smokeMeli(client, env.MELI_TEST_SELLER_ID);
  expect(result.testUserVerified).toBe(true); expect(result.orderRead).toBe(false); expect(result.canonicalParsingVerified).toBe(false);
  expect(result.operations).toEqual(['/users/me']);
  const serialized = JSON.stringify(result);
  for (const privateValue of ['fake-access', 'fake-refresh', 'fake-private', '900000001', 'private@example.invalid']) expect(serialized).not.toContain(privateValue);
});
test.each([{ tags: [], site_id: 'MLB' }, { tags: ['test_user'], site_id: 'MLA' }, { tags: ['test_user'], site_id: 'MLB', id: 900000003 }])('smoke exige conta de teste brasileira e bloqueia consulta de pedido em outra identidade', async fields => {
  let calls = 0;
  const client = new MeliClient({ clientId: env.MELI_APP_ID, clientSecret: env.MELI_CLIENT_SECRET, initialTokens: tokens,
    transport: async () => { calls++; return Response.json({ id: 900000001, ...fields }); },
  });
  await expect(smokeMeli(client, env.MELI_TEST_SELLER_ID, '2000000000000002')).rejects.toBeInstanceOf(AdapterError);
  expect(calls).toBe(1);
});
