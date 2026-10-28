import { expect, test } from 'bun:test';
import { createDatabase } from '../src';
import { requireTestDatabaseUrl } from './test-database';

test('client recusa configuração ausente ou pool inválido antes de conectar', () => {
  expect(() => createDatabase('')).toThrow('DATABASE_URL');
  for (const pool of [0, -1, 1.5, NaN]) {
    expect(() => createDatabase('postgresql://localhost/omnihub_test', pool)).toThrow('DATABASE_POOL_SIZE');
  }
});

test('proteção de banco de teste recusa banco principal e destinos inseguros', () => {
  expect(() => requireTestDatabaseUrl('postgresql://localhost/omnihub_db')).toThrow();
  expect(() => requireTestDatabaseUrl('https://localhost/omnihub_test')).toThrow();
  expect(() => requireTestDatabaseUrl(
    'postgresql://localhost/omnihub_test?sslmode=disable',
    'postgresql://other@127.0.0.1/omnihub_test',
  )).toThrow('distinto');
  expect(requireTestDatabaseUrl('postgresql://localhost/omnihub_verify', 'postgresql://localhost/omnihub_db'))
    .toBe('postgresql://localhost/omnihub_verify');
});
