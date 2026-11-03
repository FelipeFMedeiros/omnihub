import type { Database } from '@omnihub/database';
import { sql } from 'drizzle-orm';
import { HubError } from '../errors';

export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export function sqlState(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    if ('code' in current && typeof current.code === 'string') return current.code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

/** Repete somente transações abortadas por contenção; nunca repete erro de negócio. */
export async function inTransaction<T>(db: Pick<Database, 'transaction'>, run: (tx: Transaction) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
        return run(tx);
      }, { isolationLevel: 'read committed' });
    } catch (error) {
      if (!['40001', '40P01', '55P03'].includes(sqlState(error) ?? '')) throw error;
      if (attempt >= 2) {
        throw new HubError(503, 'DB_TRANSACTION_SERIALIZATION', 'Contenção temporária no banco. Tente novamente.');
      }
      await Bun.sleep(50 * 2 ** attempt + Math.floor(Math.random() * 50));
    }
  }
}
