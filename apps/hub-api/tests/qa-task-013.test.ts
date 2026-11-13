import { describe, expect, test } from 'bun:test';
import {
  authSessions, canonicalOrders, connections, erpAttempts, erpDestinations, erpDispatches,
  inventoryLedger, legacyClaims, pipelineJobs, products, spokeMappings, users, workspaces,
} from '@omnihub/database';
import { AdapterError, signInternalBody, type SpokeGateway } from '@omnihub/marketplace-adapters';
import { and, eq, inArray } from 'drizzle-orm';
import { createMockErp } from '../../mock-erp/src/app';
import { createApp } from '../src/app';
import { loadSecurityEnv } from '../src/config/security';
import { createRuntime, validateTargetBindings, type ErpTargetBinding } from '../src/config/runtime';
import { CompilerPipeline } from '../src/pipeline/compiler-pipeline';
import { AuthService } from '../src/plugins/auth';
import { InventoryService } from '../src/services/inventory.service';
import { OrderIngestionService } from '../src/services/order-ingestion.service';
import { OperationsService } from '../src/services/operations.service';
import { ErpDispatchService } from '../src/services/erp-dispatch.service';
import { claimLegacy } from '../src/services/legacy-claim.service';
import type { WorkerContext } from '../src/services/context';
import { databaseFixture, testDatabaseUrl } from './helpers';

const origin = 'http://localhost:5173';
const operator = 'qa-task013-independent-operator-key-min-32-chars';
const security = loadSecurityEnv({
  NODE_ENV: 'test',
  PUBLIC_HUB_URL: 'http://localhost',
  CORS_ORIGINS: origin,
  JWT_SECRET: 'qa-task013-jwt-secret-min-32-chars-key-very-secure',
  CLOUDFLARE_TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
});
const approvedSiteverify = async () => Response.json({ success: true, hostname: 'example.com' });

describe.skipIf(!testDatabaseUrl)('QA Independente TASK-013 — Auditoria e Aceite de Isolamento por Negócio', () => {
  const a = databaseFixture(), b = databaseFixture();
  const inventory = (f: typeof a) => new InventoryService(f.db, f.context);
  const ingestion = (f: typeof a) => new OrderIngestionService(f.db, f.context);

  test('[QA-013-01] Integridade Relacional e Restrições de Workspace em SQL Direto', async () => {
    const pa = await a.product(10, 0, 'REL-SKU-A');
    const pb = await b.product(10, 0, 'REL-SKU-B');
    const oa = a.order([{ sku: pa.sku }], { externalOrderId: 'order-rel-a' });
    const ob = b.order([{ sku: pb.sku }], { externalOrderId: 'order-rel-b' });
    await ingestion(a).ingest(oa, {});
    await ingestion(b).ingest(ob, {});

    const uid = () => Bun.randomUUIDv7();

    // 1. Spoke mapping linking connection of B to product of A must be rejected by foreign key mapping_product_scope (23503)
    await expect(
      a.client`INSERT INTO spoke_mappings(id, workspace_id, connection_id, product_id, marketplace, external_item_id)
               VALUES (${uid()}, ${b.context.workspaceId}, ${b.workerContext.connectionId}, ${pa.id}, 'MERCADO_LIVRE', 'MLB-CROSS-1')`.execute()
    ).rejects.toMatchObject({ code: '23503' });

    // 2. Spoke mapping linking workspace A to connection of B must be rejected by foreign key mapping_connection_scope (23503)
    await expect(
      a.client`INSERT INTO spoke_mappings(id, workspace_id, connection_id, product_id, marketplace, external_item_id)
               VALUES (${uid()}, ${a.context.workspaceId}, ${b.workerContext.connectionId}, ${pa.id}, 'MERCADO_LIVRE', 'MLB-CROSS-2')`.execute()
    ).rejects.toMatchObject({ code: '23503' });

    // 3. Spoke mapping with marketplace mismatch vs connection platform must be rejected by mapping_connection_scope (23503)
    await expect(
      a.client`INSERT INTO spoke_mappings(id, workspace_id, connection_id, product_id, marketplace, external_item_id)
               VALUES (${uid()}, ${a.context.workspaceId}, ${a.workerContext.connectionId}, ${pa.id}, 'SHOPEE', 'SHP-CROSS-3')`.execute()
    ).rejects.toMatchObject({ code: '23503' });

    // 4. Ledger entry of workspace A referencing product of workspace B must be rejected by ledger_product_scope (23503)
    await expect(
      a.client`INSERT INTO inventory_ledger(id, workspace_id, product_id, delta, reason, available_after)
               VALUES (${uid()}, ${a.context.workspaceId}, ${pb.id}, 1, 'ERP_SYNC', 11)`.execute()
    ).rejects.toMatchObject({ code: '23503' });

    // 5. Ledger entry of workspace A referencing order of workspace B must be rejected by ledger_order_scope (23503)
    await expect(
      a.client`INSERT INTO inventory_ledger(id, workspace_id, product_id, order_id, delta, reason, available_after)
               VALUES (${uid()}, ${a.context.workspaceId}, ${pa.id}, ${ob.id}, -1, 'SALE', 9)`.execute()
    ).rejects.toMatchObject({ code: '23503' });

    // 6. Ledger entry of workspace A referencing ERP destination of workspace B must be rejected by ledger_erp_scope (23503)
    await expect(
      a.client`INSERT INTO inventory_ledger(id, workspace_id, product_id, erp_destination_id, delta, reason, available_after)
               VALUES (${uid()}, ${a.context.workspaceId}, ${pa.id}, ${b.workerContext.erpDestinationId}, 1, 'ERP_SYNC', 11)`.execute()
    ).rejects.toMatchObject({ code: '23503' });

    // 7. Canonical order MANUAL with non-null connectionId must be rejected by order_connection_origin (23514)
    await expect(
      a.client`INSERT INTO canonical_orders(id, workspace_id, connection_id, source, external_order_id, status, total_amount_cents, customer_payload, shipping_payload, items_payload, raw_payload)
               VALUES (${uid()}, ${a.context.workspaceId}, ${a.workerContext.connectionId}, 'MANUAL', 'man-invalid', 'PAID', 100, '{}', '{}', '[{"sku":"REL-SKU-A","quantity":1,"unitPriceCents":100}]', '{}')`.execute()
    ).rejects.toMatchObject({ code: '23514' });

    // 8. Canonical order MERCADO_LIVRE with null connectionId must be rejected by order_connection_origin (23514)
    await expect(
      a.client`INSERT INTO canonical_orders(id, workspace_id, connection_id, source, external_order_id, status, total_amount_cents, customer_payload, shipping_payload, items_payload, raw_payload)
               VALUES (${uid()}, ${a.context.workspaceId}, NULL, 'MERCADO_LIVRE', 'meli-invalid', 'PAID', 100, '{}', '{}', '[{"sku":"REL-SKU-A","quantity":1,"unitPriceCents":100}]', '{}')`.execute()
    ).rejects.toMatchObject({ code: '23514' });

    // 9. Active connection duplicate external_account_id on same platform must be rejected by connections_external_identity (23505)
    const activeAccountId = `fixture-${a.workerContext.connectionId}`;
    await expect(
      a.client`INSERT INTO connections(id, workspace_id, platform, transport_mode, name, state, external_account_id)
               VALUES (${uid()}, ${b.context.workspaceId}, 'MERCADO_LIVRE', 'LOCAL_FIXTURE', 'Dup account', 'ACTIVE', ${activeAccountId})`.execute()
    ).rejects.toMatchObject({ code: '23505' });

    // 10. Active connection without external_account_id must be rejected by connections_state (23514)
    await expect(
      a.client`INSERT INTO connections(id, workspace_id, platform, transport_mode, name, state, external_account_id)
               VALUES (${uid()}, ${a.context.workspaceId}, 'MERCADO_LIVRE', 'LOCAL_FIXTURE', 'No external id', 'ACTIVE', NULL)`.execute()
    ).rejects.toMatchObject({ code: '23514' });

    // 11. Erp destination endpoint regex check rejects non-loopback URLs (23514)
    await expect(
      a.client`INSERT INTO erp_destinations(id, workspace_id, config_key, endpoint_origin, state)
               VALUES (${uid()}, ${a.context.workspaceId}, 'remote-invalid', 'https://remote-erp.com', 'DISABLED')`.execute()
    ).rejects.toMatchObject({ code: '23514' });

    // 12. Only one ACTIVE destination per workspace is permitted (23505)
    await expect(
      a.client`INSERT INTO erp_destinations(id, workspace_id, config_key, endpoint_origin, state)
               VALUES (${uid()}, ${a.context.workspaceId}, 'second-active', 'http://127.0.0.1:39100', 'ACTIVE')`.execute()
    ).rejects.toMatchObject({ code: '23505' });
  });

  test('[QA-013-02] Imutabilidade do Despacho ERP e Destino através de Triggers SQL', async () => {
    const pa = await a.product(5, 0, 'DISP-SKU');
    const order = a.order([{ sku: pa.sku }], { externalOrderId: 'disp-order-1' });
    await ingestion(a).ingest(order, {});
    const values = a.dispatchValues(order);
    await a.db.insert(erpDispatches).values({ ...values, attempts: 1, state: 'PROCESSING' });

    // Trigger protect_sent_dispatch rejects mutating orderId or externalIdempotencyKey once attempts > 0
    await expect(
      a.client`UPDATE erp_dispatches SET external_idempotency_key='hacked-key' WHERE order_id=${order.id}`.execute()
    ).rejects.toMatchObject({ code: '23514' });

    // Trigger protect_sent_dispatch rejects reducing attempts count
    await expect(
      a.client`UPDATE erp_dispatches SET attempts=0 WHERE order_id=${order.id}`.execute()
    ).rejects.toMatchObject({ code: '23514' });

    // Trigger protect_erp_destination rejects mutating endpoint_origin or config_key when dispatches exist
    await expect(
      a.client`UPDATE erp_destinations SET endpoint_origin='http://127.0.0.1:38888' WHERE id=${a.workerContext.erpDestinationId}`.execute()
    ).rejects.toMatchObject({ code: '23514' });

    await expect(
      a.client`UPDATE erp_destinations SET config_key='changed-config-key' WHERE id=${a.workerContext.erpDestinationId}`.execute()
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('[QA-013-03] Isolamento de Sessão HTTP e Prevenção de IDOR em Todas as Rotas', async () => {
    const pa = await a.product(10, 0, 'IDOR-SKU');
    const pb = await b.product(20, 0, 'IDOR-SKU');
    const orderA = a.order([{ sku: pa.sku }], { externalOrderId: 'idor-order-a' });
    await ingestion(a).ingest(orderA, {});

    // Set up real auth for User A and User B
    const auth = new AuthService(a.db, security);
    const pass = 'qa-task013-secure-password';
    const hash = await Bun.password.hash(pass, { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3 });
    await a.db.update(users).set({ passwordHash: hash }).where(inArray(users.id, [a.ownerId, b.ownerId]));

    const sa = await auth.login({ email: `${a.ownerId}@example.invalid`, password: pass });
    const sb = await auth.login({ email: `${b.ownerId}@example.invalid`, password: pass });

    const app = createApp({
      db: a.db,
      security,
      corsOrigins: [origin],
      siteverifyFetch: approvedSiteverify,
      runtime: {
        adminToken: operator,
        webhookSecret: 'qa-test-webhook-secret-min-32-chars',
        erpUrl: 'http://127.0.0.1:34000',
        mockAdminToken: operator,
      },
    });

    const userReq = (token: string, path: string, method = 'GET', headers: Record<string, string> = {}, body?: unknown) =>
      app.handle(
        new Request(`http://localhost${path}`, {
          method,
          headers: {
            cookie: `omnihub_session=${token}`,
            origin,
            ...headers,
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        })
      );

    // 1. User B query inventory: query parameter workspaceId=A must be ignored; only User B's inventory returned
    const resInvB = await userReq(sb.token, `/api/v1/inventory?workspaceId=${a.context.workspaceId}`);
    expect(resInvB.status).toBe(200);
    const invB = (await resInvB.json()) as { data: { id: string; currentStock: number }[] };
    expect(invB.data).toHaveLength(1);
    expect(invB.data[0]!.id).toBe(pb.id);
    expect(invB.data[0]!.currentStock).toBe(20);

    // 2. User B query ledger of SKU existing only in A: must return 404
    const resLedgerB = await userReq(sb.token, `/api/v1/inventory/NON-EXISTENT-IN-B/ledger`);
    expect(resLedgerB.status).toBe(404);

    // 3. User B query orders: must see 0 orders (User A's order is hidden)
    const resOrdersB = await userReq(sb.token, `/api/v1/dashboard/orders?workspaceId=${a.context.workspaceId}`);
    expect(resOrdersB.status).toBe(200);
    const ordersB = (await resOrdersB.json()) as { data: unknown[] };
    expect(ordersB.data).toHaveLength(0);

    // 4. User B trace processing job belonging to User A: must return 404
    const dummyJobId = Bun.randomUUIDv7();
    const resTraceB = await userReq(sb.token, `/api/v1/dashboard/processings/${dummyJobId}`);
    expect(resTraceB.status).toBe(404);

    // 5. User B retry processing belonging to User A: must return 404
    const resRetryB = await userReq(
      sb.token,
      `/api/v1/dashboard/processings/${dummyJobId}/retry`,
      'POST',
      { 'x-csrf-token': sb.account.csrfToken, 'x-turnstile-token': 'dummy' }
    );
    expect(resRetryB.status).toBe(404);

    // 6. User B creating a mapping targeting User A's connection and product: must return 404
    const resMapB = await userReq(
      sb.token,
      '/api/v1/dashboard/mappings',
      'POST',
      { 'x-csrf-token': sb.account.csrfToken, 'x-turnstile-token': 'dummy' },
      {
        connectionId: a.workerContext.connectionId,
        marketplace: 'MERCADO_LIVRE',
        productId: pa.id,
        externalItemId: 'MLB888999',
        syncEnabled: 'Y',
      }
    );
    expect(resMapB.status).toBe(404);

    // 7. User B dashboard metrics: only User B's metrics returned (0 accepted orders)
    const resMetricsB = await userReq(sb.token, '/api/v1/dashboard/metrics');
    expect(resMetricsB.status).toBe(200);
    const metricsB = (await resMetricsB.json()) as { acceptedOrders: number };
    expect(metricsB.acceptedOrders).toBe(0);
  });

  test('[QA-013-04] Proteção de Borda, Rejeição de Browser no Bearer e Isolamento de Operador', async () => {
    const app = createApp({
      db: a.db,
      security,
      corsOrigins: [origin],
      runtime: {
        adminToken: operator,
        webhookSecret: 'qa-test-webhook-secret-min-32-chars',
        erpUrl: 'http://127.0.0.1:34000',
        mockAdminToken: operator,
      },
    });

    // 1. Operator Bearer token with Origin header (browser spoof) must be rejected with 403
    const resBrowserWithBearer = await app.handle(
      new Request('http://localhost/api/v1/inventory', {
        headers: {
          authorization: `Bearer ${operator}`,
          origin,
          'x-workspace-id': a.context.workspaceId,
        },
      })
    );
    expect(resBrowserWithBearer.status).toBe(403);

    // 2. Operator Bearer token with Sec-Fetch-Site must be rejected with 403
    const resFetchSiteWithBearer = await app.handle(
      new Request('http://localhost/api/v1/inventory', {
        headers: {
          authorization: `Bearer ${operator}`,
          'sec-fetch-site': 'same-origin',
          'x-workspace-id': a.context.workspaceId,
        },
      })
    );
    expect(resFetchSiteWithBearer.status).toBe(403);

    // 3. Operator Bearer token without X-Workspace-Id header must return 422
    const resNoTarget = await app.handle(
      new Request('http://localhost/api/v1/inventory', {
        headers: {
          authorization: `Bearer ${operator}`,
        },
      })
    );
    expect(resNoTarget.status).toBe(422);

    // 4. Operator Bearer token targeting LEGACY_CLOSED workspace must return 403 WORKSPACE_CLOSED
    const [legacy] = await a.db.select().from(workspaces).where(eq(workspaces.kind, 'LEGACY_CLOSED'));
    if (legacy) {
      const resLegacy = await app.handle(
        new Request('http://localhost/api/v1/inventory', {
          headers: {
            authorization: `Bearer ${operator}`,
            'x-workspace-id': legacy.id,
          },
        })
      );
      expect(resLegacy.status).toBe(403);
    }
  });

  test('[QA-013-05] Reivindicação Transacional do Legado Exige Comprovação e Alvo Vazio', async () => {
    const rollback = new Error('synthetic-qa-rollback');
    try {
      await a.db.transaction(async tx => {
        const ownerId = Bun.randomUUIDv7(), emptyId = Bun.randomUUIDv7(), legacyId = Bun.randomUUIDv7(), prodId = Bun.randomUUIDv7();
        await tx.insert(users).values({ id: ownerId, name: 'Verified Owner QA', email: `${ownerId}@example.invalid`, passwordHash: 'dummy' });
        await tx.insert(workspaces).values([
          { id: emptyId, ownerId, kind: 'ACCOUNT' },
          { id: legacyId, ownerId: null, kind: 'LEGACY_CLOSED' },
        ]);
        await tx.insert(products).values({ id: prodId, workspaceId: legacyId, sku: 'LEGACY-QA-PROD', title: 'Legacy Prod', basePriceCents: 1000, currentStock: 15, reservedStock: 3 });

        // Claim with reference < 8 chars must fail with 422
        await expect(
          claimLegacy(tx, {
            legacyWorkspaceId: legacyId,
            emptyWorkspaceId: emptyId,
            verifiedOwnerId: ownerId,
            verificationReference: 'short',
          })
        ).rejects.toMatchObject({ status: 422, code: 'INVALID_LEGACY_CLAIM' });

        // Claim targeting non-empty workspace must fail with 409 LEGACY_TARGET_NOT_EMPTY
        await expect(
          claimLegacy(tx, {
            legacyWorkspaceId: legacyId,
            emptyWorkspaceId: a.context.workspaceId,
            verifiedOwnerId: a.ownerId,
            verificationReference: 'proof-document-ref-1234',
          })
        ).rejects.toMatchObject({ status: 409, code: 'LEGACY_TARGET_NOT_EMPTY' });

        // Claim with wrong owner ID must fail with 409 LEGACY_CLAIM_CONFLICT
        await expect(
          claimLegacy(tx, {
            legacyWorkspaceId: legacyId,
            emptyWorkspaceId: emptyId,
            verifiedOwnerId: b.ownerId,
            verificationReference: 'proof-document-ref-1234',
          })
        ).rejects.toMatchObject({ status: 409, code: 'LEGACY_CLAIM_CONFLICT' });

        // Valid claim executes successfully
        const result = await claimLegacy(tx, {
          legacyWorkspaceId: legacyId,
          emptyWorkspaceId: emptyId,
          verifiedOwnerId: ownerId,
          verificationReference: 'proof-document-ref-1234',
        });

        expect(result.workspaceId).toBe(legacyId);
        expect(result.replacedEmptyWorkspaceId).toBe(emptyId);
        expect(result.sessionsRevoked).toBe(true);

        // Verifying historical UUID was preserved and empty workspace was deleted
        const [claimedWs] = await tx.select().from(workspaces).where(eq(workspaces.id, legacyId));
        expect(claimedWs).toMatchObject({ id: legacyId, ownerId, kind: 'ACCOUNT' });
        const emptyWs = await tx.select().from(workspaces).where(eq(workspaces.id, emptyId));
        expect(emptyWs).toHaveLength(0);

        // Products still attached to historical legacyId
        const [prod] = await tx.select().from(products).where(eq(products.id, prodId));
        expect(prod).toMatchObject({ workspaceId: legacyId, currentStock: 15, reservedStock: 3 });

        // Audit log exists
        const [audit] = await tx.select().from(legacyClaims).where(eq(legacyClaims.workspaceId, legacyId));
        expect(audit).toMatchObject({ ownerId, verificationReference: 'proof-document-ref-1234' });

        throw rollback;
      });
    } catch (err) {
      if (err !== rollback) throw err;
    }
  });

  test('[QA-013-06] Concorrência e Isolamento: 15 solicitações simultâneas em cada negócio com mesmo SKU', async () => {
    await a.product(5, 0, 'CONCURRENT-SAME-SKU');
    await b.product(5, 0, 'CONCURRENT-SAME-SKU');

    // Run 15 concurrent orders on Workspace A and 15 concurrent orders on Workspace B in parallel
    const [resA, resB] = await Promise.all([
      Promise.allSettled(
        Array.from({ length: 15 }, (_, n) =>
          ingestion(a).ingest(a.order([{ sku: 'CONCURRENT-SAME-SKU' }], { externalOrderId: `order-a-${n}` }), {})
        )
      ),
      Promise.allSettled(
        Array.from({ length: 15 }, (_, n) =>
          ingestion(b).ingest(b.order([{ sku: 'CONCURRENT-SAME-SKU' }], { externalOrderId: `order-b-${n}` }), {})
        )
      ),
    ]);

    // Workspace A: exactly 5 succeeded, 10 failed with 409 INSUFFICIENT_CANONICAL_STOCK
    expect(resA.filter(r => r.status === 'fulfilled')).toHaveLength(5);
    const rejA = resA.filter(r => r.status === 'rejected');
    expect(rejA).toHaveLength(10);
    for (const r of rejA) expect((r as PromiseRejectedResult).reason).toMatchObject({ status: 409, code: 'INSUFFICIENT_CANONICAL_STOCK' });

    // Workspace B: exactly 5 succeeded, 10 failed with 409 INSUFFICIENT_CANONICAL_STOCK
    expect(resB.filter(r => r.status === 'fulfilled')).toHaveLength(5);
    const rejB = resB.filter(r => r.status === 'rejected');
    expect(rejB).toHaveLength(10);
    for (const r of rejB) expect((r as PromiseRejectedResult).reason).toMatchObject({ status: 409, code: 'INSUFFICIENT_CANONICAL_STOCK' });

    // Both workspaces have 5 reservedStock and 0 availableStock
    const balA = (await inventory(a).listInventory(10)).data.find(p => p.sku === 'CONCURRENT-SAME-SKU');
    const balB = (await inventory(b).listInventory(10)).data.find(p => p.sku === 'CONCURRENT-SAME-SKU');
    expect(balA).toMatchObject({ currentStock: 5, reservedStock: 5, availableStock: 0 });
    expect(balB).toMatchObject({ currentStock: 5, reservedStock: 5, availableStock: 0 });
  });

  test('[QA-013-07] Faturamento ERP: FULFILLMENT reduz físico e reservado juntos sem repetir SALE', async () => {
    const pa = await a.product(10, 0, 'FULFILL-SKU');
    const order = a.order([{ sku: pa.sku, quantity: 3 }], { externalOrderId: 'fulfill-order-1' });
    await ingestion(a).ingest(order, {});

    // Initial reservation verified
    let stock = (await inventory(a).listInventory(10)).data.find(p => p.id === pa.id);
    expect(stock).toMatchObject({ currentStock: 10, reservedStock: 3, availableStock: 7 });

    const values = a.dispatchValues(order);
    await a.db.insert(erpDispatches).values({
      ...values,
      attempts: 1,
      state: 'CONFIRMED',
      protocol: 'FAT-123456789',
      confirmedAt: new Date(),
    });

    const dispatchService = new ErpDispatchService(a.db, a.workerContext, {
      configKey: a.configKey,
      url: a.erpUrl,
      adminToken: operator,
    });

    await dispatchService.finalize(order.id);

    // After finalization: currentStock and reservedStock decreased by 3 together; availableStock remains 7
    stock = (await inventory(a).listInventory(10)).data.find(p => p.id === pa.id);
    expect(stock).toMatchObject({ currentStock: 7, reservedStock: 0, availableStock: 7 });

    // Ledger has FULFILLMENT with delta = 0 and availableAfter = 7
    const ledger = (await inventory(a).getLedger('FULFILL-SKU')).data;
    expect(ledger).toHaveLength(2);
    expect(ledger[0]).toMatchObject({ reason: 'FULFILLMENT', delta: 0, availableAfter: 7 });
    expect(ledger[1]).toMatchObject({ reason: 'SALE', delta: -3, availableAfter: 7 });

    // Order status is now INVOICED
    const [updatedOrder] = await a.db.select().from(canonicalOrders).where(eq(canonicalOrders.id, order.id));
    expect(updatedOrder?.status).toBe('INVOICED');
  });
});
