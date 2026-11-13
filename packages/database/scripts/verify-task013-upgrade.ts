import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDatabase } from '../src/client';
import { requireTestDatabaseUrl } from '../src/testing';
import { seedDatabase } from '../src/seed';

// Explicit destructive rehearsal, never imported by the test runner or run on development.
if (!process.argv.includes('--reset-task013-test')) throw new Error('Explicit --reset-task013-test required');
const url = requireTestDatabaseUrl(process.env.TEST_DATABASE_URL ?? '', process.env.DATABASE_URL);
if (new URL(url).pathname !== '/omnihub_task013_test_db') throw new Error('Only the dedicated TASK-013 test database is allowed');
const { db, client } = createDatabase(url, 1);
const root = resolve(import.meta.dir, '../../..');
const folder = resolve(root, 'output/task-013/upgrade-through-0004');
const migrations = resolve(import.meta.dir, '../drizzle');
const id = (n: number) => `018f0013-0000-7000-8000-${String(n).padStart(12, '0')}`;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
try {
  await mkdir(`${folder}/meta`, { recursive: true });
  const journal = JSON.parse(await readFile(`${migrations}/meta/_journal.json`, 'utf8')) as { entries: { idx: number; tag: string }[] };
  const old = { ...journal, entries: journal.entries.filter(e => e.idx <= 4) };
  await writeFile(`${folder}/meta/_journal.json`, JSON.stringify(old));
  for (const entry of old.entries) await writeFile(`${folder}/${entry.tag}.sql`, await readFile(`${migrations}/${entry.tag}.sql`));
  await client.unsafe('DROP SCHEMA IF EXISTS public CASCADE');
  await client.unsafe('DROP SCHEMA IF EXISTS drizzle CASCADE');
  await client.unsafe('CREATE SCHEMA public');
  await migrate(db, { migrationsFolder: folder });
  await client`INSERT INTO users(id,name,email,password_hash) VALUES (${id(1)},'Upgrade fixture','upgrade-task013@example.invalid','not-a-login-hash')`;
  await client`INSERT INTO workspaces(id,owner_id,name) VALUES (${id(2)},${id(1)},'Auth workspace preserved')`;
  await client`INSERT INTO auth_sessions(id,user_id,issued_at,expires_at) VALUES (${id(3)},${id(1)},'2026-11-12T10:00:00Z','2026-11-12T11:00:00Z')`;
  await client`INSERT INTO products(id,sku,title,base_price_cents,current_stock,reserved_stock,safety_stock) VALUES (${id(4)},'UPGRADE-RESERVED','Upgrade fixture',100,5,2,0)`;
  const customer = { externalCustomerId: 'fixture', documentNumber: '12345678901', name: 'Synthetic', email: 'synthetic@example.invalid' };
  const shipping = { street: 'Synthetic', number: '1', neighborhood: 'Centro', city: 'Mossoro', state: 'RN', postalCode: '59600000' };
  const items = [{ sku: 'UPGRADE-RESERVED', externalItemId: 'same-item', title: 'Fixture', quantity: 2, unitPriceCents: 100, currency: 'BRL' }];
  const raw = { fixture: 'upgrade', nested: { preserved: true } };
  const payload = { codigo_pedido: 'MERCADO_LIVRE-legacy-order', origem_canal: 'MERCADO_LIVRE', documento_cliente: '12345678901', cep_entrega: '59600000', uf_entrega: 'RN', valor_total: 2, itens_pedido: [{ codigo_sku: 'UPGRADE-RESERVED', quantidade: 2, preco_unitario: 1 }] };
  await client`INSERT INTO canonical_orders(id,source,external_order_id,status,total_amount_cents,customer_payload,shipping_payload,items_payload,raw_payload) VALUES (${id(5)},'MERCADO_LIVRE','legacy-order','PAID',200,${JSON.stringify(customer)},${JSON.stringify(shipping)},${JSON.stringify(items)},${JSON.stringify(raw)})`;
  await client`INSERT INTO spoke_mappings(id,product_id,marketplace,external_item_id,sync_enabled) VALUES (${id(6)},${id(4)},'MERCADO_LIVRE','sandbox-upgrade','N')`;
  await client`INSERT INTO inventory_ledger(id,product_id,order_id,delta,reason,available_after) VALUES (${id(7)},${id(4)},${id(5)},-2,'SALE',3)`;
  await client`INSERT INTO pipeline_jobs(id,source,external_order_id,fingerprint,order_id,state,outcome,raw_snapshot,canonical_snapshot,erp_snapshot) VALUES (${id(8)},'MERCADO_LIVRE','legacy-order',${'1'.repeat(64)},${id(5)},'FAILED','CREATED',${JSON.stringify(raw)},${JSON.stringify({ id: id(5), items })},${JSON.stringify(payload)})`;
  await client`INSERT INTO erp_dispatches(order_id,state,payload,attempts,error_code) VALUES (${id(5)},'EXHAUSTED',${JSON.stringify(payload)},3,'ERP_RETRIES_EXHAUSTED')`;
  for (let n = 1; n <= 3; n++) await client`INSERT INTO erp_attempts(id,order_id,ordinal,http_status,outcome) VALUES (${id(10+n)},${id(5)},${n},503,'TEMPORARY_FAILURE')`;
  // A persisted receipt must retain the exact historical external key and payload too.
  await client`INSERT INTO canonical_orders(id,source,external_order_id,status,total_amount_cents,customer_payload,shipping_payload,items_payload,raw_payload) VALUES (${id(20)},'MANUAL','confirmed-legacy','INVOICED',200,${JSON.stringify(customer)},${JSON.stringify(shipping)},${JSON.stringify(items)},${JSON.stringify(raw)})`;
  const confirmed = { ...payload, codigo_pedido: 'MANUAL-confirmed-legacy', origem_canal: 'MANUAL' };
  await client`INSERT INTO erp_dispatches(order_id,state,payload,attempts,protocol,confirmed_at) VALUES (${id(20)},'CONFIRMED',${JSON.stringify(confirmed)},1,'FAT-preserved','2026-11-12T10:00:00Z')`;
  const tables = ['users','workspaces','auth_sessions','products','spoke_mappings','canonical_orders','inventory_ledger','pipeline_jobs','erp_dispatches','erp_attempts'];
  const before: Record<string, Record<string, unknown>[]> = {};
  for (const table of tables) before[table] = await client.unsafe(`SELECT * FROM ${table} ORDER BY ${table === 'erp_dispatches' ? 'order_id' : 'id'}`);
  await migrate(db, { migrationsFolder: migrations });
  const evidence: Record<string, unknown> = {};
  for (const table of tables) {
    const columns = Object.keys(before[table]![0]!);
    const after = await client.unsafe(`SELECT ${columns.map(c => `"${c}"`).join(',')} FROM ${table} WHERE ${table === 'erp_dispatches' ? 'order_id' : 'id'} = ANY($1::uuid[]) ORDER BY ${table === 'erp_dispatches' ? 'order_id' : 'id'}`, [before[table]!.map(row => row[table === 'erp_dispatches' ? 'order_id' : 'id'] as string)]);
    if (JSON.stringify(before[table]) !== JSON.stringify([...after])) throw new Error(`Upgrade changed historical ${table}`);
    evidence[table] = { rows: after.length, sha256: digest([...after]) };
  }
  const [closed] = await client`SELECT id,owner_id,kind FROM workspaces WHERE kind='LEGACY_CLOSED'`;
  if (!closed || closed.owner_id !== null) throw new Error('Legacy is not closed');
  const [exhausted] = await client`SELECT attempts,external_idempotency_key,state FROM erp_dispatches WHERE order_id=${id(5)}`;
  if (exhausted?.attempts !== 3 || exhausted.external_idempotency_key !== payload.codigo_pedido) throw new Error('Budget/key not preserved');
  await migrate(db, { migrationsFolder: migrations });
  await writeFile(resolve(root, 'output/task-013/upgrade-result.json'), JSON.stringify({ database: 'omnihub_task013_test_db', from: '0004', to: journal.entries.at(-1)?.tag, reapplication: 'passed', legacyClosed: true, preserved: evidence }, null, 2));
  console.log('Upgrade from 0004 through the current migration journal passed: auth/domain UUIDs, balances, snapshots, payloads, protocol and exhausted budget preserved; reapplication passed.');
  if (process.argv.includes('--fresh-after-upgrade')) {
    await client.unsafe('DROP SCHEMA public CASCADE');
    await client.unsafe('DROP SCHEMA drizzle CASCADE');
    await client.unsafe('CREATE SCHEMA public');
    await migrate(db, { migrationsFolder: migrations });
    await seedDatabase(db);
    await client`UPDATE products SET current_stock=7 WHERE sku='SKU-FONTE-600W'`;
    await migrate(db, { migrationsFolder: migrations });
    await seedDatabase(db);
    const [row] = await client`SELECT (SELECT count(*)::int FROM products) AS products, (SELECT count(*)::int FROM spoke_mappings) AS mappings, (SELECT count(*)::int FROM spoke_mappings WHERE sync_enabled='Y') AS enabled, (SELECT count(*)::int FROM users) AS users, (SELECT current_stock FROM products WHERE sku='SKU-FONTE-600W') AS preserved_stock`;
    if (row?.products !== 3 || row.mappings !== 9 || row.enabled !== 0 || row.users !== 0 || row.preserved_stock !== 7) throw new Error('Fresh/seed replay invariants failed');
    await writeFile(resolve(root, 'output/task-013/fresh-result.json'), JSON.stringify({ database: 'omnihub_task013_test_db', freshMigrations: 'passed', reapplication: 'passed', seedReapplication: 'passed', counts: row }, null, 2));
    console.log('Fresh migrations, reapplication and idempotent disabled seed passed on the dedicated test database.');
  }
} finally { await client.end(); }
