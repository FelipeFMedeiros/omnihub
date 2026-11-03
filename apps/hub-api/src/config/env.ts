import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const EnvironmentSchema = Type.Object({
  host: Type.String({ minLength: 1 }),
  port: Type.Integer({ minimum: 1, maximum: 65535 }),
  databaseUrl: Type.String({ minLength: 1 }),
  databasePoolSize: Type.Integer({ minimum: 1 }),
  corsOrigins: Type.Array(Type.String()),
});

export function loadEnv(env: NodeJS.ProcessEnv = process.env) {
  const config = {
    host: env.HUB_HOST ?? '0.0.0.0',
    port: Number(env.HUB_PORT ?? 3000),
    databaseUrl: env.DATABASE_URL ?? '',
    databasePoolSize: Number(env.DATABASE_POOL_SIZE ?? 20),
    corsOrigins: (env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map((value) => value.trim()).filter(Boolean),
  };
  if (!Value.Check(EnvironmentSchema, config)) {
    throw new Error('Configuração inválida: confira DATABASE_URL, DATABASE_POOL_SIZE, HUB_HOST e HUB_PORT.');
  }
  let databaseUrl: URL;
  try { databaseUrl = new URL(config.databaseUrl); }
  catch { throw new Error('DATABASE_URL deve ser uma URL PostgreSQL válida.'); }
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol) || !databaseUrl.hostname || databaseUrl.pathname.length < 2) {
    throw new Error('DATABASE_URL deve ser uma URL PostgreSQL válida.');
  }
  for (const origin of config.corsOrigins) {
    let parsed: URL;
    try { parsed = new URL(origin); }
    catch { throw new Error('CORS_ORIGINS deve conter origens HTTP separadas por vírgula.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error('CORS_ORIGINS deve conter origens HTTP sem caminho nem credenciais.');
    }
  }
  return config;
}
