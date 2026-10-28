import { eq } from 'drizzle-orm';
import { createDatabase, type Database } from './client';
import { products, spokeMappings } from './schema';

const catalog = [
  { sku: 'SKU-FONTE-600W', title: 'Fonte ATX 600W 80 Plus Bronze', basePriceCents: 34990, currentStock: 20 },
  { sku: 'SKU-SSD-NVME-1TB', title: 'SSD NVMe 1TB', basePriceCents: 49990, currentStock: 30 },
  { sku: 'SKU-MEM-DDR5-16GB', title: 'Memória DDR5 16GB', basePriceCents: 29990, currentStock: 40 },
] as const;

const marketplaces = ['MERCADO_LIVRE', 'SHOPEE', 'AMAZON'] as const;

/** Reexecuções preservam preços, saldos e vínculos existentes. */
export async function seedDatabase(db: Pick<Database, 'transaction'>): Promise<void> {
  await db.transaction(async (tx) => {
    for (const [position, product] of catalog.entries()) {
      await tx.insert(products).values(product).onConflictDoNothing({ target: products.sku });
      const [stored] = await tx.select({ id: products.id }).from(products).where(eq(products.sku, product.sku));
      if (!stored) throw new Error(`Produto não encontrado após seed: ${product.sku}`);

      for (const marketplace of marketplaces) {
        await tx.insert(spokeMappings).values({
          productId: stored.id,
          marketplace,
          externalItemId: `sandbox-${marketplace.toLowerCase()}-${position + 1}`,
          externalSku: product.sku,
        }).onConflictDoNothing({ target: [spokeMappings.marketplace, spokeMappings.externalItemId] });
      }
    }
  });
}

if (import.meta.main) {
  const { db, client } = createDatabase();
  try {
    await seedDatabase(db);
    console.log('Seed concluído: 3 SKUs e 9 mapeamentos sandbox (sem redefinir registros existentes).');
  } finally {
    await client.end();
  }
}
