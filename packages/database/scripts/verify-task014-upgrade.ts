import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDatabase } from '../src/client';
import { requireTestDatabaseUrl } from '../src/testing';
import { seedDatabase } from '../src/seed';

if (!process.argv.includes('--reset-task014-test')) throw new Error('Explicit dedicated reset flag required');
const url = requireTestDatabaseUrl(process.env.TEST_DATABASE_URL ?? '', process.env.DATABASE_URL);
if (new URL(url).pathname !== '/omnihub_task014_test_db') throw new Error('Only TASK-014 dedicated test database allowed');
const { db, client } = createDatabase(url, 1), root = resolve(import.meta.dir, '../../..');
const folder = resolve(root, 'output/task-014/upgrade-through-0007'), migrations = resolve(import.meta.dir, '../drizzle');
const id = (n: number) => `018f0014-0000-7000-8000-${String(n).padStart(12,'0')}`;
const reset = async () => { await client.unsafe('DROP SCHEMA IF EXISTS public CASCADE'); await client.unsafe('DROP SCHEMA IF EXISTS drizzle CASCADE'); await client.unsafe('CREATE SCHEMA public'); };
try {
  await mkdir(`${folder}/meta`, { recursive: true });
  const journal = JSON.parse(await readFile(`${migrations}/meta/_journal.json`, 'utf8')) as { entries: { idx: number; tag: string }[] };
  const old = { ...journal, entries: journal.entries.filter(e => e.idx <= 7) };
  await writeFile(`${folder}/meta/_journal.json`, JSON.stringify(old));
  for (const entry of old.entries) await writeFile(`${folder}/${entry.tag}.sql`, await readFile(`${migrations}/${entry.tag}.sql`));
  await reset(); await migrate(db, { migrationsFolder: folder }); await seedDatabase(db);
  await client`INSERT INTO users(id,name,email,password_hash) VALUES (${id(1)},'Synthetic upgrade','upgrade14@example.invalid','not-a-login-hash')`;
  await client`INSERT INTO workspaces(id,owner_id) VALUES (${id(2)},${id(1)})`;
  await client`INSERT INTO auth_sessions(id,user_id,issued_at,expires_at) VALUES (${id(3)},${id(1)},'2026-11-13T10:00:00Z','2026-11-13T11:00:00Z')`;
  await client`INSERT INTO connections(id,workspace_id,platform,transport_mode,external_account_id,state,name) VALUES (${id(4)},${id(2)},'MERCADO_LIVRE','LOCAL_FIXTURE','local-upgrade14','ACTIVE','Upgrade shop')`;
  await client`INSERT INTO erp_destinations(id,workspace_id,config_key,endpoint_origin,state) VALUES (${id(5)},${id(2)},'upgrade14','http://127.0.0.1:34999','ACTIVE')`;
  await client`INSERT INTO products(id,workspace_id,sku,title,base_price_cents,current_stock,reserved_stock,safety_stock) VALUES (${id(6)},${id(2)},'UPGRADE14','Synthetic',100,5,2,0)`;
  const raw = JSON.stringify({ fixture: 'TASK014_UPGRADE', nested: { keep: true } });
  const items = JSON.stringify([{ sku: 'UPGRADE14', quantity: 2, unitPriceCents: 100 }]);
  const payload = JSON.stringify({ codigo_pedido: 'oh:upgrade14:reserved', fixture: true });
  await client`INSERT INTO canonical_orders(id,workspace_id,connection_id,source,external_order_id,status,total_amount_cents,customer_payload,shipping_payload,items_payload,raw_payload) VALUES (${id(7)},${id(2)},${id(4)},'MERCADO_LIVRE','reserved','PAID',200,'{}','{}',${items},${raw})`;
  await client`INSERT INTO inventory_ledger(id,workspace_id,product_id,order_id,delta,reason,available_after) VALUES (${id(8)},${id(2)},${id(6)},${id(7)},-2,'SALE',3)`;
  await client`INSERT INTO pipeline_jobs(id,workspace_id,connection_id,erp_destination_id,source,transport_mode,external_order_id,fingerprint,order_id,state,outcome,raw_snapshot,canonical_snapshot,erp_snapshot) VALUES (${id(9)},${id(2)},${id(4)},${id(5)},'MERCADO_LIVRE','LOCAL_FIXTURE','reserved',${'a'.repeat(64)},${id(7)},'FAILED','CREATED',${raw},${items},${payload})`;
  await client`INSERT INTO erp_dispatches(order_id,workspace_id,erp_destination_id,external_idempotency_key,state,payload,attempts) VALUES (${id(7)},${id(2)},${id(5)},'oh:upgrade14:reserved','EXHAUSTED',${payload},3)`;
  for (let n=1;n<=3;n++) await client`INSERT INTO erp_attempts(id,workspace_id,erp_destination_id,order_id,ordinal,outcome) VALUES (${id(10+n)},${id(2)},${id(5)},${id(7)},${n},'STARTED')`;
  const tables = ['users','workspaces','auth_sessions','connections','erp_destinations','products','spoke_mappings','canonical_orders','inventory_ledger','pipeline_jobs','erp_dispatches','erp_attempts'];
  const before: Record<string, Record<string, unknown>[]> = {};
  for (const table of tables) before[table] = [...await client.unsafe(`SELECT * FROM ${table} ORDER BY ${table === 'erp_dispatches' ? 'order_id' : 'id'}`)];
  await migrate(db, { migrationsFolder: migrations });
  const preserved: Record<string, unknown> = {};
  for (const table of tables) {
    const rows = before[table]!; if (!rows.length) continue;
    const columns = Object.keys(rows[0]!);
    const after = [...await client.unsafe(`SELECT ${columns.map(c=>`"${c}"`).join(',')} FROM ${table} ORDER BY ${table === 'erp_dispatches' ? 'order_id' : 'id'}`)];
    if (JSON.stringify(rows) !== JSON.stringify(after)) throw new Error(`Historical ${table} changed`);
    preserved[table] = { rows: rows.length, sha256: createHash('sha256').update(JSON.stringify(after)).digest('hex') };
  }
  await migrate(db, { migrationsFolder: migrations });
  await writeFile(resolve(root, 'output/task-014/upgrade-result.json'), JSON.stringify({ database: 'omnihub_task014_test_db', from: '0007', to: journal.entries.at(-1)?.tag, preserved, reapplication: 'passed' }, null, 2));
  await reset(); await migrate(db, { migrationsFolder: migrations }); await migrate(db, { migrationsFolder: migrations }); await seedDatabase(db); await seedDatabase(db);
  console.log('TASK-014 upgrade 0007 -> current preserved all historical columns, reservations and exhausted budget; fresh creation, reapplication and double seed passed.');
} finally { await client.end(); }
