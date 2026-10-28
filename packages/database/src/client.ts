import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

/** A importação do pacote não abre conexões nem exige variáveis de ambiente. */
export function createDatabase(
  databaseUrl = process.env.DATABASE_URL,
  poolSize = Number(process.env.DATABASE_POOL_SIZE ?? 20),
) {
  if (!databaseUrl) throw new Error('DATABASE_URL deve ser configurada.');
  if (!Number.isInteger(poolSize) || poolSize < 1) {
    throw new Error('DATABASE_POOL_SIZE deve ser um inteiro positivo.');
  }
  const client = postgres(databaseUrl, { max: poolSize });
  const db = drizzle(client, { schema });
  return { db, client };
}

export type Database = ReturnType<typeof createDatabase>['db'];
