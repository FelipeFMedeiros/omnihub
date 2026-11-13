import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SignJWT } from 'jose';
import { and, eq, inArray } from 'drizzle-orm';
import { authSessions, connectionAuthorizations, connectionCredentials, connections, erpDestinations, erpDispatches, inventoryLedger, pipelineJobs, products, spokeMappings } from '@omnihub/database';
import { MeliClient, MeliGateway, type MeliTokens } from '@omnihub/marketplace-adapters';
import { createApp } from '../src/app';
import { loadSecurityEnv } from '../src/config/security';
import { validateTargetBindings, type PipelineRuntime, type ErpTargetBinding } from '../src/config/runtime';
import { CredentialCipher } from '../src/services/credential-cipher';
import { ConnectionCredentialStore, type ConnectionSettings } from '../src/services/connection-credentials';
import { ConnectionsService } from '../src/services/connections.service';
import { ConnectionRuntime } from '../src/services/connection-runtime';
import { importConnection } from '../src/services/connection-import';
import { AuthService, type AuthenticatedSession } from '../src/plugins/auth';
import { createMockErp } from '../../mock-erp/src/app';
import { OperationsService } from '../src/services/operations.service';
import officialFixture from '../../../packages/marketplace-adapters/tests/fixtures/meli-order-legacy.json';
import { databaseFixture, testDatabaseUrl } from './helpers';

const origin = 'http://localhost:5173';
const security = loadSecurityEnv({ NODE_ENV: 'test', PUBLIC_HUB_URL: 'http://localhost', CORS_ORIGINS: origin, JWT_SECRET: 'task014-local-test-private-key-'.repeat(3), CLOUDFLARE_TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' });
const settings: ConnectionSettings = { clientId: '123456', clientSecret: 'task014-local-test-app-secret', redirectUri: 'https://callback.example.invalid/api/oauth/meli/callback', publicHubUrl: 'http://localhost', returnUrl: `${origin}/connections` };
const keys = new Map([['v1', randomBytes(32)]]), cipher = new CredentialCipher('v1', keys);
const operator = 'task014-local-operator-'.repeat(3);
const accountId = () => String(BigInt(`0x${Bun.randomUUIDv7().replaceAll('-','')}`));

test('AES-GCM binds workspace, connection, app, purpose and version; nonce, tampering and key rotation', () => {
  const scope = { workspaceId: 'a', connectionId: 'b', appId: 'app', purpose: 'tokens' };
  const envelope = cipher.seal({ secret: 'synthetic-secret' }, scope);
  expect(envelope).not.toContain('synthetic-secret'); expect(cipher.seal({ secret: 'synthetic-secret' }, scope)).not.toBe(envelope);
  expect(cipher.open(envelope, scope)).toEqual({ secret: 'synthetic-secret' });
  for (const change of [{ workspaceId:'other' }, { connectionId:'other' }, { appId:'other' }, { purpose:'other' }]) expect(() => cipher.open(envelope, { ...scope, ...change })).toThrow();
  const raw = JSON.parse(envelope) as Record<string, unknown>; raw.tag = randomBytes(16).toString('base64url');
  expect(() => cipher.open(JSON.stringify(raw), scope)).toThrow();
  const rotated = new CredentialCipher('v2', new Map([...keys, ['v2', randomBytes(32)]]));
  expect(rotated.open(envelope, scope)).toEqual({ secret: 'synthetic-secret' });
  expect(() => new CredentialCipher('v2', new Map([['v2',randomBytes(32)]])).open(envelope,scope)).toThrow();
  expect(() => new CredentialCipher('v1',new Map([['v1',randomBytes(32)]])).open(envelope,scope)).toThrow();
});

describe.skipIf(!testDatabaseUrl)('TASK-014 connections, OAuth, encrypted custody, simulation and ERP', () => {
  const a = databaseFixture(), b = databaseFixture();
  const created = new Set<string>(), sessions = new Set<string>(), extraDestinations = new Set<string>();
  afterEach(async () => {
    if (created.size) await a.db.delete(connections).where(inArray(connections.id,[...created]));
    if (sessions.size) await a.db.delete(authSessions).where(inArray(authSessions.id,[...sessions]));
    if (extraDestinations.size) await a.db.delete(erpDestinations).where(inArray(erpDestinations.id,[...extraDestinations]));
    created.clear(); sessions.clear(); extraDestinations.clear();
  });
  async function login(f = a) {
    const now = Math.floor(Date.now()/1000), sid = Bun.randomUUIDv7(); sessions.add(sid);
    await a.db.insert(authSessions).values({ id:sid,userId:f.ownerId,issuedAt:new Date(now*1000),expiresAt:new Date((now+3600)*1000) });
    const token = await new SignJWT({sid}).setProtectedHeader({alg:'HS256',typ:'JWT'}).setSubject(f.ownerId).setIssuer(security.issuer).setAudience(security.audience).setIssuedAt(now).setExpirationTime(now+3600).sign(new TextEncoder().encode(security.jwtSecret));
    const cookie = `omnihub_session=${token}`;
    const session = await new AuthService(a.db,security).authenticate(new Request('http://localhost',{headers:{cookie}}));
    return { cookie, session };
  }
  function transport(options: { failGrant?: boolean; wrongIdentity?: boolean; testUser?: boolean; site?: string } = {}) {
    const grants: string[] = [], reads: string[] = [];
    const run = async (request: Request) => {
      expect(new URL(request.url).origin).toBe('https://api.mercadolibre.com');
      if (request.method === 'POST') {
        const form = new URLSearchParams(await request.text()), credential = form.get('code') ?? form.get('refresh_token')!;
        const user = credential.split(':')[1]!; grants.push(user);
        if (options.failGrant) throw new Error('synthetic grant network ambiguity');
        return Response.json({ access_token:`access:${user}:new`,refresh_token:`refresh:${user}:new`,user_id:user,expires_in:3600,token_type:'bearer' });
      }
      const user = request.headers.get('authorization')!.split(':')[1]!; reads.push(user);
      expect(new URL(request.url).pathname).toBe('/users/me');
      return Response.json({ id:options.wrongIdentity?'999':user,site_id:options.site??'MLB',tags:options.testUser===false?[]:['test_user'] });
    };
    return {run,grants,reads};
  }
  function setup(t = transport(), targets?: ErpTargetBinding[]) {
    const store = new ConnectionCredentialStore(a.db,cipher,{...settings,transport:t.run});
    const service = new ConnectionsService(a.db,store), pipelines: NonNullable<PipelineRuntime['pipelines']>[number][] = [];
    const manager = new ConnectionRuntime(a.db,service,pipelines,targets??[]);
    const runtime: PipelineRuntime = {adminToken:operator,webhookSecret:'',erpUrl:'',mockAdminToken:'',pipelines,erpTargets:targets??[],connectionRuntime:manager};
    let challenges=0;
    const app = createApp({db:a.db,security,runtime,corsOrigins:[origin],siteverifyFetch:async()=>{challenges++;return Response.json({success:true,hostname:'example.com'});}});
    const request = (path:string, auth?:Awaited<ReturnType<typeof login>>, body?:unknown, headers:Record<string,string>={}, method=body?'POST':'GET') => app.handle(new Request(`http://localhost${path}`,{method,
      headers:{...(auth?{cookie:auth.cookie}:{}),...(method==='POST'?{origin,'x-csrf-token':auth?.session.account.csrfToken??'','x-turnstile-token':'synthetic-challenge'}:{}),...(body?{'content-type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})}));
    return {store,service,manager,runtime,app,request,t,get challenges(){return challenges;}};
  }
  async function create(h:ReturnType<typeof setup>, f=a, mode:'OFFICIAL_TEST_USER'|'LOCAL_FIXTURE'='OFFICIAL_TEST_USER') {
    const row=await h.service.create(f.context,{name:'Synthetic shop',platform:'MERCADO_LIVRE',transportMode:mode});created.add(row.id);return row;
  }
  async function pending(h:ReturnType<typeof setup>,auth:Awaited<ReturnType<typeof login>>,id:string,user=accountId()) {
    const start=await h.service.start(auth.session,id), url=new URL(settings.redirectUri);
    url.search=new URLSearchParams({state:new URL(start.authorizationUrl).searchParams.get('state')!,code:`code:${user}:synthetic`}).toString();
    await h.service.callback(url.toString());return {...start,user,url};
  }
  async function activate(h:ReturnType<typeof setup>, id:string,user=accountId(),expired=false,f=a) {
    const tokens:MeliTokens={accessToken:`access:${user}:initial`,refreshToken:`refresh:${user}:initial`,userId:user,expiresAt:Date.now()+(expired?-1000:3600000)};
    await a.db.update(connections).set({state:'ACTIVE',credentialState:'CONNECTED',externalAccountId:user}).where(eq(connections.id,id));
    await a.db.insert(connectionCredentials).values({workspaceId:f.context.workspaceId,connectionId:id,appId:settings.clientId,envelope:cipher.seal(tokens,h.store.scope(f.context.workspaceId,id))});return tokens;
  }

  test('typed browser contracts require session, Origin, CSRF, Turnstile; polling is challenge-free and safe',async()=>{
    const h=setup(),auth=await login(),other=await login(b);
    expect((await h.request('/api/v1/connections')).status).toBe(401);
    expect((await h.request('/api/v1/connections',undefined,undefined,{authorization:`Bearer ${operator}`,'x-workspace-id':a.context.workspaceId})).status).toBe(401);
    const body={name:'My shop',platform:'MERCADO_LIVRE',transportMode:'OFFICIAL_TEST_USER'};
    const denied: Record<string,string>[] = [{origin:'https://evil.invalid'},{'x-csrf-token':'wrong'},{'x-turnstile-token':''}];
    for(const headers of denied) expect((await h.request('/api/v1/connections',auth,body,headers)).status).toBe(403);
    const response=await h.request('/api/v1/connections',auth,body);expect(response.status).toBe(201);const row=await response.json() as {id:string};created.add(row.id);
    const count=h.challenges;
    expect((await h.request(`/api/v1/connections/${row.id}/oauth`,auth)).status).toBe(200);
    const listed=await (await h.request('/api/v1/connections',auth)).text();expect(h.challenges).toBe(count);
    for(const secret of ['accessToken','refreshToken','envelope',operator,settings.clientSecret,security.jwtSecret])expect(listed).not.toContain(secret);
    expect((await h.request(`/api/v1/connections/${row.id}/check`,other,{}, {},'POST')).status).toBe(404);
    expect((await h.request(`/api/v1/connections/${row.id}/disable`,other,{}, {},'POST')).status).toBe(404);
  });

  test('cross-host callback works without local cookie; only initiating session confirms; replay fails',async()=>{
    const h=setup(),auth=await login(),replacement=await login(),row=await create(h);
    const start=await h.service.start(auth.session,row.id),url=new URL(settings.redirectUri),user=accountId();
    url.search=new URLSearchParams({state:new URL(start.authorizationUrl).searchParams.get('state')!,code:`code:${user}:synthetic`}).toString();
    const callback=await h.app.handle(new Request(url.toString()));expect(callback.status).toBe(303);expect(callback.headers.get('location')).toBe(settings.returnUrl);
    expect(callback.headers.get('referrer-policy')).toBe('no-referrer');expect(await callback.text()).toBe('');
    expect((await h.service.get(a.context,row.id)).state).toBe('DISABLED');
    await expect(h.service.confirm(replacement.session,row.id,start.attemptId)).rejects.toMatchObject({code:'OAUTH_STATE_INVALID'});
    expect((await h.service.confirm(auth.session,row.id,start.attemptId)).status).toBe('CONNECTED');
    await expect(h.service.callback(url.toString())).rejects.toMatchObject({code:'OAUTH_STATE_INVALID'});
    await expect(h.service.confirm(auth.session,row.id,start.attemptId)).rejects.toMatchObject({code:'OAUTH_STATE_INVALID'});
    expect(h.t.grants).toHaveLength(1);
  });

  test('unrequested, malformed, expired, wrong-host and duplicate-state callbacks never consume code',async()=>{
    const h=setup(),auth=await login(),row=await create(h),start=await h.service.start(auth.session,row.id),state=new URL(start.authorizationUrl).searchParams.get('state')!;
    for(const url of [`${settings.redirectUri}?state=unknown&code=synthetic`,`${settings.redirectUri}?state=${state}&state=${state}&code=synthetic`,`https://evil.invalid/api/oauth/meli/callback?state=${state}&code=synthetic`])await expect(h.service.callback(url)).rejects.toBeDefined();
    await a.db.update(connectionAuthorizations).set({expiresAt:new Date(0)}).where(eq(connectionAuthorizations.id,start.attemptId));
    await expect(h.service.callback(`${settings.redirectUri}?state=${state}&code=synthetic`)).rejects.toBeDefined();expect(h.t.grants).toHaveLength(0);
  });

  test('revocation and expiration block callbacks and pending confirmation without grant retry',async()=>{
    for(const expire of [false,true]){
      const h=setup(),auth=await login(),row=await create(h),p=await pending(h,auth,row.id);
      if(expire)await a.db.update(authSessions).set({issuedAt:new Date(Date.now()-3600000),expiresAt:new Date(Date.now()-1000)}).where(eq(authSessions.id,auth.session.id));
      else await new AuthService(a.db,security).logout(auth.session);
      await expect(h.service.confirm(auth.session,row.id,p.attemptId)).rejects.toMatchObject({code:'UNAUTHENTICATED'});
      expect((await h.service.get(a.context,row.id)).state).toBe('DISABLED');expect(h.t.grants).toHaveLength(1);
    }
    const h=setup(),auth=await login(),row=await create(h),start=await h.service.start(auth.session,row.id),state=new URL(start.authorizationUrl).searchParams.get('state')!;
    await new AuthService(a.db,security).logout(auth.session);
    await expect(h.service.callback(`${settings.redirectUri}?state=${state}&code=code:123:synthetic`)).rejects.toMatchObject({code:'UNAUTHENTICATED'});expect(h.t.grants).toHaveLength(0);
  });

  test('two authorizations cannot overwrite a shop and two workspaces cannot claim one external account',async()=>{
    const h=setup(),auth=await login(),other=await login(b),one=await create(h),two=await create(h,b),user=accountId();
    const pa=await pending(h,auth,one.id,user),pb=await pending(h,other,two.id,user);
    const results=await Promise.allSettled([h.service.confirm(auth.session,one.id,pa.attemptId),h.service.confirm(other.session,two.id,pb.attemptId)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
    const winner=results[0]!.status==='fulfilled'?{auth,row:one,p:pa}:{auth:other,row:two,p:pb};
    const newAttempt=await pending(h,winner.auth,winner.row.id,user);
    await expect(pending(h,winner.auth,winner.row.id,accountId())).rejects.toBeDefined();
    await expect(h.service.confirm(winner.auth.session,winner.row.id,newAttempt.attemptId)).rejects.toMatchObject({code:'OAUTH_STATE_INVALID'});
    expect((await h.service.get({workspaceId:winner.auth.session.account.workspace.id},winner.row.id)).externalAccountId).toBe(user);
  });

  test('callback rejects non-test and non-MLB identities; simultaneous replay executes one POST',async()=>{
    for(const options of [{testUser:false},{site:'MLA'},{wrongIdentity:true}]){
      const h=setup(transport(options)),auth=await login(),row=await create(h);
      await expect(pending(h,auth,row.id)).rejects.toBeDefined();expect((await h.service.get(a.context,row.id)).state).toBe('DISABLED');
    }
    const h=setup(),auth=await login(),row=await create(h),start=await h.service.start(auth.session,row.id),state=new URL(start.authorizationUrl).searchParams.get('state')!,user=accountId();
    const url=`${settings.redirectUri}?state=${state}&code=code:${user}:synthetic`;
    const results=await Promise.allSettled([h.service.callback(url),h.service.callback(url)]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(h.t.grants).toHaveLength(1);
  });

  test('per-connection DB leases serialize refresh across store instances; restart retains rotated ciphertext',async()=>{
    const h=setup(),one=await create(h),two=await create(h),u1=accountId(),u2=accountId();
    await activate(h,one.id,u1,true);await activate(h,two.id,u2,true);
    const restarted=new ConnectionCredentialStore(a.db,new CredentialCipher('v1',keys),{...settings,transport:h.t.run});
    const reads=await Promise.all(Array.from({length:12},(_,index)=>(index%2?h.store:restarted).use(a.context,index%2?one.id:two.id,client=>client.getCurrentUser())));
    expect(reads.every((r,index)=>r.id===(index%2?u1:u2))).toBe(true);expect(h.t.grants.sort()).toEqual([u1,u2].sort());
    for(const id of [one.id,two.id]){
      const [stored]=await a.db.select().from(connectionCredentials).where(eq(connectionCredentials.connectionId,id));expect(stored!.revision).toBe(2);expect(stored!.phase).toBe('READY');expect(stored!.envelope).not.toContain('access:');
      await restarted.use(a.context,id,client=>client.getCurrentUser());
    }
    expect(h.t.grants).toHaveLength(2);
  });

  test('ambiguous refresh fails closed, never retries POST, and reconnection recovers same account',async()=>{
    const t=transport({failGrant:true}),h=setup(t),row=await create(h),user=accountId();await activate(h,row.id,user,true);
    await expect(h.store.use(a.context,row.id,client=>client.getCurrentUser())).rejects.toBeDefined();
    await expect(h.store.use(a.context,row.id,client=>client.getCurrentUser())).rejects.toMatchObject({code:'REAUTH_REQUIRED'});
    expect(t.grants).toHaveLength(1);expect((await h.service.get(a.context,row.id)).credentialState).toBe('REAUTH_REQUIRED');
    const recovered=setup(),auth=await login(),p=await pending(recovered,auth,row.id,user);
    expect((await recovered.service.confirm(auth.session,row.id,p.attemptId)).status).toBe('CONNECTED');
  });

  test('expired in-flight rotation, missing key, tampered and swapped envelopes require reauthorization',async()=>{
    const h=setup(),one=await create(h),two=await create(h);await activate(h,one.id);await activate(h,two.id);
    const [original]=await a.db.select().from(connectionCredentials).where(eq(connectionCredentials.connectionId,one.id));
    await a.db.update(connectionCredentials).set({envelope:original!.envelope}).where(eq(connectionCredentials.connectionId,two.id));
    await expect(h.store.use(a.context,two.id,c=>c.getCurrentUser())).rejects.toMatchObject({code:'CREDENTIAL_UNAVAILABLE'});
    const wrong=new ConnectionCredentialStore(a.db,new CredentialCipher('v2',new Map([['v2',randomBytes(32)]])),{...settings,transport:h.t.run});
    await expect(wrong.use(a.context,one.id,c=>c.getCurrentUser())).rejects.toMatchObject({code:'CREDENTIAL_UNAVAILABLE'});
    const three=await create(h);await activate(h,three.id,accountId(),true);
    await a.db.update(connectionCredentials).set({phase:'ROTATING',leaseUntil:new Date(0),leaseToken:Bun.randomUUIDv7()}).where(eq(connectionCredentials.connectionId,three.id));
    await expect(h.store.use(a.context,three.id,c=>c.getCurrentUser())).rejects.toMatchObject({code:'REAUTH_REQUIRED'});expect(h.t.grants).toHaveLength(0);expect(h.t.reads).toHaveLength(0);
  });

  test('disable fences pending callback/confirm and credential use, preserving historical identity',async()=>{
    const h=setup(),auth=await login(),row=await create(h),p=await pending(h,auth,row.id);
    await h.service.disable(a.context,row.id);await expect(h.service.confirm(auth.session,row.id,p.attemptId)).rejects.toBeDefined();
    const second=await create(h),user=accountId();await activate(h,second.id,user);
    await h.service.disable(a.context,second.id);await expect(h.store.use(a.context,second.id,c=>c.getCurrentUser())).rejects.toMatchObject({code:'REAUTH_REQUIRED'});
    expect((await h.service.get(a.context,second.id)).externalAccountId).toBe(user);
    expect(await a.db.select().from(connectionCredentials).where(eq(connectionCredentials.connectionId,second.id))).toHaveLength(0);
  });

  test('measurement is scoped and durable and never turns missing transport into a success',async()=>{
    const h=setup(),one=await create(h),two=await create(h,b);await activate(h,one.id);await activate(h,two.id,accountId(),false,b);
    expect((await h.service.check(a.context,one.id)).checkStatus).toBe('AVAILABLE');
    await expect(h.service.check(a.context,two.id)).rejects.toMatchObject({code:'CONNECTION_NOT_FOUND'});
    const restarted=new ConnectionsService(a.db,h.store);expect((await restarted.list(a.context)).data.find(c=>c.id===one.id)!.checkedAt).not.toBeNull();
    await h.service.disable(a.context,one.id);expect((await h.service.check(a.context,one.id)).checkedAt).toBeNull();
    const future=await h.service.create(a.context,{name:'Future',platform:'AMAZON',transportMode:'OFFICIAL_TEST_USER'});created.add(future.id);expect(future.status).toBe('NOT_IMPLEMENTED');await expect(h.service.check(a.context,future.id)).rejects.toMatchObject({code:'NOT_IMPLEMENTED'});
  });

  test('explicit import verifies owner, app, fresh test identity and target; bootstrap/reimport/cross-tenant rejected',async()=>{
    const h=setup(),row=await create(h),user=accountId();
    const folder=resolve('output/task-014/private-test-import',Bun.randomUUIDv7());await mkdir(folder,{recursive:true});
    const tokens={accessToken:`access:${user}:fixture`,refreshToken:`refresh:${user}:fixture`,userId:user,expiresAt:Date.now()+3600000};
    await writeFile(`${folder}/tokens.json`,JSON.stringify({version:1,clientId:settings.clientId,tokens}));
    await writeFile(`${folder}/bootstrap-tokens.json`,JSON.stringify({version:1,clientId:settings.clientId,tokens}));
    const input={workspaceId:a.context.workspaceId,connectionId:row.id,verifiedOwnerId:a.ownerId,expectedAccountId:user,verificationReference:'synthetic-verified-owner',source:`${folder}/tokens.json`};
    await expect(importConnection(h.store,{...input,source:`${folder}/bootstrap-tokens.json`})).rejects.toMatchObject({code:'IMPORT_SOURCE_FORBIDDEN'});
    await expect(importConnection(h.store,{...input,verifiedOwnerId:b.ownerId})).rejects.toMatchObject({code:'IMPORT_TARGET_REJECTED'});
    expect((await importConnection(h.store,input)).identityMatches).toBe(true);
    await expect(importConnection(h.store,input)).rejects.toBeDefined();expect(h.t.grants).toHaveLength(0);
  });

  function targetFor(f=a):ErpTargetBinding {
    const erp=createMockErp({adminToken:operator,webhookSecret:'task014-isolated-webhook-'.repeat(2),hubWebhookUrl:'http://127.0.0.1:1/not-used',chaos:{minMs:0,maxMs:0,failureRate:0}});
    return {...f.workerContext,url:f.erpUrl,configKey:f.configKey,adminToken:operator,webhookSecret:'task014-isolated-webhook-'.repeat(2),transport:r=>erp.handle(r),sleep:async()=>{}};
  }
  test('simulation authenticates scoped fixed local fixture and runs real parser, reservation and Mock ERP',async()=>{
    const h=setup(transport(),[targetFor()]),auth=await login(),row=await create(h,a,'LOCAL_FIXTURE'),product=await a.product(5,0,'SKU-FONTE-600W');
    await a.db.insert(spokeMappings).values({workspaceId:a.context.workspaceId,connectionId:row.id,productId:product.id,marketplace:'MERCADO_LIVRE',externalItemId:'MLB1234567890',syncEnabled:'Y'});
    const response=await h.request(`/api/v1/connections/${row.id}/simulate`,auth,{scenario:'PAID'});expect(response.status).toBe(200);
    const job=await response.json() as {processingId:string;origin:string};a.trackProcessing(job.processingId);expect(job.origin).toBe('LOCAL_FIXTURE_TASK014_V1');
    const pipeline=h.runtime.pipelines!.find(p=>p.context.connectionId===row.id)!;expect(await pipeline.runOnce()).toBe(true);
    const [stored]=await a.db.select().from(pipelineJobs).where(eq(pipelineJobs.id,job.processingId));if(stored!.orderId)a.trackOrder(stored!.orderId);
    expect(stored!.state).toBe('SUCCEEDED');expect(stored!.rawSnapshot).toBeDefined();expect(stored!.canonicalSnapshot).toBeDefined();expect(stored!.erpSnapshot).toBeDefined();
    const [balance]=await a.db.select().from(products).where(eq(products.id,product.id));expect(balance!.currentStock).toBe(3);expect(balance!.reservedStock).toBe(0);
    const ledger=await a.db.select().from(inventoryLedger).where(eq(inventoryLedger.orderId,stored!.orderId!));expect(ledger.filter(l=>l.reason==='SALE')).toHaveLength(1);expect(ledger.filter(l=>l.reason==='FULFILLMENT')).toHaveLength(1);
    expect(h.t.grants).toHaveLength(0);expect(h.t.reads).toHaveLength(0);
    const bad=await h.manager.simulate(a.context,row.id,'INVALID_TOTAL');a.trackProcessing(bad.processingId);await pipeline.runOnce();const [invalid]=await a.db.select().from(pipelineJobs).where(eq(pipelineJobs.id,bad.processingId));expect(invalid!.state).toBe('FAILED');expect(invalid!.orderId).toBeNull();
    expect((await h.request(`/api/v1/connections/${row.id}/simulate`,auth,{scenario:'PAID',payload:{url:'https://evil.invalid'}})).status).toBe(422);
    expect((await h.request('/api/webhooks/meli',undefined,{origin:'LOCAL_FIXTURE_TASK014_V1',connectionId:row.id,orderId:'12341'})).status).toBe(403);
    const official=await create(h);expect((await h.request(`/api/v1/connections/${official.id}/simulate`,auth,{scenario:'PAID'})).status).toBe(409);
  });

  test('ERP selection uses an operator allowlist, denies foreign IDs and URLs, preserves one active target',async()=>{
    const t1=targetFor(),id=Bun.randomUUIDv7();extraDestinations.add(id);
    await a.db.insert(erpDestinations).values({id,workspaceId:a.context.workspaceId,configKey:`second-${id}`,endpointOrigin:'http://127.0.0.1:34998',state:'DISABLED'});
    const t2={...t1,erpDestinationId:id,configKey:`second-${id}`,url:'http://localhost:34998',webhookSecret:'task014-second-isolated-secret-'.repeat(2)};
    validateTargetBindings([t1,t2]);const h=setup(transport(),[t1,t2]),auth=await login();
    expect((await h.manager.erpList(b.context)).data).toHaveLength(0);
    expect((await h.request('/api/v1/erp-destinations/select',auth,{destinationId:id,url:'http://evil.invalid'})).status).toBe(422);
    await expect(h.manager.selectErp(a.context,b.workerContext.erpDestinationId)).rejects.toMatchObject({code:'ERP_DESTINATION_NOT_FOUND'});
    await h.manager.selectErp(a.context,id);expect((await h.manager.erpList(a.context)).data.filter(t=>t.state==='ACTIVE').map(t=>t.id)).toEqual([id]);
    await h.manager.selectErp(a.context,a.workerContext.erpDestinationId);
  });

  const latch = () => { let resolve: () => void = () => {}; const promise = new Promise<void>(r => { resolve=r; }); return {promise,resolve}; };
  async function simulation(h: ReturnType<typeof setup>) {
    const row=await create(h,a,'LOCAL_FIXTURE'),product=await a.product(5,0,'SKU-FONTE-600W');
    await a.db.insert(spokeMappings).values({workspaceId:a.context.workspaceId,connectionId:row.id,productId:product.id,marketplace:'MERCADO_LIVRE',externalItemId:'MLB1234567890',syncEnabled:'Y'});
    const job=await h.manager.simulate(a.context,row.id,'PAID');a.trackProcessing(job.processingId);
    const pipeline=h.runtime.pipelines!.find(p=>p.context.connectionId===row.id)!;
    return {row,product,job,pipeline};
  }
  test('disable while fetching prevents reservation and new jobs or publication',async()=>{
    const h=setup(transport(),[targetFor()]),{row,product,job,pipeline}=await simulation(h),entered=latch(),release=latch();
    const load=pipeline.gateway.loadOrder.bind(pipeline.gateway);
    pipeline.gateway.loadOrder=async id=>{entered.resolve();await release.promise;return load(id);};
    const running=pipeline.runOnce();await entered.promise;
    await h.service.disable(a.context,row.id);release.resolve();await running;
    const [stored]=await a.db.select().from(pipelineJobs).where(eq(pipelineJobs.id,job.processingId));expect(stored!.state).toBe('FAILED');expect(stored!.orderId).toBeNull();
    const [stock]=await a.db.select().from(products).where(eq(products.id,product.id));expect(stock!.reservedStock).toBe(0);expect(stock!.currentStock).toBe(5);
    await expect(h.manager.simulate(a.context,row.id,'PAID')).rejects.toMatchObject({code:'CONNECTION_NOT_FOUND'});
    await expect(pipeline.syncStock([product.sku])).rejects.toMatchObject({code:'CONNECTION_NOT_FOUND'});
    await expect(new OperationsService(a.db,a.context).retry(job.processingId)).rejects.toMatchObject({code:'CONNECTION_NOT_FOUND'});
  });

  test('disable after ERP started allows pinned dispatch confirmation, never cancels or repeats SALE',async()=>{
    const target=targetFor(),entered=latch(),release=latch(),base=target.transport!;let posts=0;
    target.transport=async request=>{if(request.method==='POST'){posts++;entered.resolve();await release.promise;}return base(request);};
    const h=setup(transport(),[target]),{row,product,job,pipeline}=await simulation(h);
    const running=pipeline.runOnce();await entered.promise;
    const [inFlight]=await a.db.select().from(pipelineJobs).where(eq(pipelineJobs.id,job.processingId));a.trackOrder(inFlight!.orderId!);
    const [reserved]=await a.db.select().from(products).where(eq(products.id,product.id));expect(reserved!.currentStock).toBe(5);expect(reserved!.reservedStock).toBe(2);
    await h.service.disable(a.context,row.id);release.resolve();await running;
    const [stock]=await a.db.select().from(products).where(eq(products.id,product.id));expect(stock!.currentStock).toBe(3);expect(stock!.reservedStock).toBe(0);expect(posts).toBe(1);
    const [dispatch]=await a.db.select().from(erpDispatches).where(eq(erpDispatches.orderId,inFlight!.orderId!));expect(dispatch!.erpDestinationId).toBe(target.erpDestinationId);expect(dispatch!.attempts).toBe(1);
    const ledger=await a.db.select().from(inventoryLedger).where(eq(inventoryLedger.orderId,inFlight!.orderId!));expect(ledger.map(l=>l.reason).sort()).toEqual(['FULFILLMENT','SALE']);
    await expect(pipeline.runOnce()).rejects.toMatchObject({code:'CONNECTION_NOT_FOUND'});
  });

  test('disabled exhausted dispatch keeps reservation, immutable destination/key and three-attempt budget',async()=>{
    const target=targetFor();let posts=0;target.transport=async()=>{posts++;return new Response(null,{status:503});};
    const h=setup(transport(),[target]),{row,product,job,pipeline}=await simulation(h);await pipeline.runOnce();
    const [stored]=await a.db.select().from(pipelineJobs).where(eq(pipelineJobs.id,job.processingId));a.trackOrder(stored!.orderId!);
    const [before]=await a.db.select().from(erpDispatches).where(eq(erpDispatches.orderId,stored!.orderId!));expect(posts).toBe(3);expect(before!.attempts).toBe(3);
    await h.service.disable(a.context,row.id);
    const [after]=await a.db.select().from(erpDispatches).where(eq(erpDispatches.orderId,stored!.orderId!));expect(after).toEqual(before);
    const [stock]=await a.db.select().from(products).where(eq(products.id,product.id));expect(stock!.currentStock).toBe(5);expect(stock!.reservedStock).toBe(2);
    await expect(new OperationsService(a.db,a.context).retry(job.processingId)).rejects.toBeDefined();expect(posts).toBe(3);
  });

  test('ERP switch is refused for queued work and preserves destination; callback secrets stay isolated',async()=>{
    const t1=targetFor(),id=Bun.randomUUIDv7();extraDestinations.add(id);
    await a.db.insert(erpDestinations).values({id,workspaceId:a.context.workspaceId,configKey:`queued-${id}`,endpointOrigin:'http://127.0.0.1:34997',state:'DISABLED'});
    const t2={...t1,erpDestinationId:id,configKey:`queued-${id}`,url:'http://127.0.0.1:34997',webhookSecret:'task014-queued-isolated-secret-'.repeat(2)};
    const h=setup(transport(),[t1,t2]),{job}=await simulation(h);
    await expect(h.manager.selectErp(a.context,id)).rejects.toMatchObject({code:'ERP_WORK_IN_PROGRESS'});
    const [stored]=await a.db.select().from(pipelineJobs).where(eq(pipelineJobs.id,job.processingId));expect(stored!.erpDestinationId).toBe(t1.erpDestinationId);
    const signature=(await import('@omnihub/marketplace-adapters')).signInternalBody(JSON.stringify({movementId:Bun.randomUUIDv7(),sku:'SKU-FONTE-600W',quantity:1}),t1.webhookSecret);
    const response=await h.request(`/api/webhooks/erp-stock/${id}`,undefined,{movementId:Bun.randomUUIDv7(),sku:'SKU-FONTE-600W',quantity:1},{'x-erp-signature':signature});expect(response.status).toBe(403);
  });

  test('official notification resolves correct workspace; forged resource owner is rejected before reservation and ambiguity fails',async()=>{
    const t=transport(),user=accountId(),run=t.run;
    t.run=async request=>{
      if(new URL(request.url).pathname.startsWith('/orders/'))return Response.json({...officialFixture,seller:{id:'999'},id:'2000000000000001'});
      return run(request);
    };
    const h=setup(t,[targetFor()]),row=await create(h);await activate(h,row.id,user);await h.manager.reconcile();
    const notice={topic:'orders_v2',resource:'/orders/2000000000000001',application_id:settings.clientId,user_id:user,workspaceId:b.context.workspaceId};
    const response=await h.request('/api/webhooks/meli',undefined,notice);expect(response.status).toBe(200);
    const job=await response.json() as {processingId:string};a.trackProcessing(job.processingId);
    const pipeline=h.runtime.pipelines!.find(p=>p.context.connectionId===row.id)!;await pipeline.runOnce();
    const [stored]=await a.db.select().from(pipelineJobs).where(eq(pipelineJobs.id,job.processingId));expect(stored!.workspaceId).toBe(a.context.workspaceId);expect(stored!.connectionId).toBe(row.id);expect(stored!.errorCode).toBe('ADAPTER_RESOURCE_MISMATCH');expect(stored!.orderId).toBeNull();
    (h.runtime.pipelines as typeof pipeline[]).push(pipeline);
    expect((await h.request('/api/webhooks/meli',undefined,notice)).status).toBe(403);
    expect((await h.request('/api/webhooks/meli',undefined,{...notice,resource:'https://evil.invalid/orders/1'})).status).toBe(403);
  });

  test('HTTP upstream with the pinned public callback host still requires session confirmation',async()=>{
    const h=setup(),auth=await login(),row=await create(h),start=await h.service.start(auth.session,row.id),state=new URL(start.authorizationUrl).searchParams.get('state')!,user=accountId();
    const upstream=new URL(settings.redirectUri);upstream.protocol='http:';upstream.search=new URLSearchParams({state,code:`code:${user}:synthetic`}).toString();
    expect((await h.app.handle(new Request(upstream.toString()))).status).toBe(303);
    expect((await h.service.get(a.context,row.id)).state).toBe('DISABLED');
    expect((await h.service.confirm(auth.session,row.id,start.attemptId)).status).toBe('CONNECTED');
  });

  test('rotation persistence failure is fenced durably and a repeated read cannot send a second refresh',async()=>{
    const h=setup(),row=await create(h);await activate(h,row.id,accountId(),true);
    const seal=spyOn(cipher,'seal').mockImplementation(()=>{throw new Error('synthetic persistence precondition failure');});
    try { await expect(h.store.use(a.context,row.id,c=>c.getCurrentUser())).rejects.toMatchObject({code:'MELI_TOKEN_PERSISTENCE_FAILED'}); } finally { seal.mockRestore(); }
    expect(h.t.grants).toHaveLength(1);expect((await h.service.get(a.context,row.id)).credentialState).toBe('REAUTH_REQUIRED');
    await expect(h.store.use(a.context,row.id,c=>c.getCurrentUser())).rejects.toMatchObject({code:'REAUTH_REQUIRED'});expect(h.t.grants).toHaveLength(1);
  });

  test('disable during a single-use refresh prevents credential resurrection or subsequent authorized HTTP',async()=>{
    const t=transport(),run=t.run,entered=latch(),release=latch();
    t.run=async request=>{if(request.method==='POST'){entered.resolve();await release.promise;}return run(request);};
    const h=setup(t),row=await create(h);await activate(h,row.id,accountId(),true);
    const reading=h.store.use(a.context,row.id,c=>c.getCurrentUser());await entered.promise;
    await h.service.disable(a.context,row.id);release.resolve();await expect(reading).rejects.toBeDefined();
    expect(await a.db.select().from(connectionCredentials).where(eq(connectionCredentials.connectionId,row.id))).toHaveLength(0);
    expect((await h.service.get(a.context,row.id)).state).toBe('DISABLED');expect(t.reads).toHaveLength(0);expect(t.grants).toHaveLength(1);
  });

  test('connection crypto/callback/refresh perform no transport call inside a database transaction',async()=>{
    const t=transport(),run=t.run,h=setup(t),auth=await login(),row=await create(h);let depth=0;
    const original=a.db.transaction.bind(a.db);
    const transaction=spyOn(a.db,'transaction').mockImplementation(async (fn,options)=>original(async tx=>{depth++;try{return await fn(tx);}finally{depth--;}},options));
    t.run=async request=>{expect(depth).toBe(0);return run(request);};
    // The configured transport is captured explicitly to retain this instrumentation.
    const store=new ConnectionCredentialStore(a.db,cipher,{...settings,transport:t.run}),service=new ConnectionsService(a.db,store);
    try {
      const start=await service.start(auth.session,row.id),state=new URL(start.authorizationUrl).searchParams.get('state')!,user=accountId();
      await service.callback(`${settings.redirectUri}?state=${state}&code=code:${user}:synthetic`);await service.confirm(auth.session,row.id,start.attemptId);
      const [stored]=await a.db.select().from(connectionCredentials).where(eq(connectionCredentials.connectionId,row.id));
      const tokens=cipher.open(stored!.envelope,store.scope(a.context.workspaceId,row.id)) as MeliTokens;
      await a.db.update(connectionCredentials).set({envelope:cipher.seal({...tokens,expiresAt:0},store.scope(a.context.workspaceId,row.id))}).where(eq(connectionCredentials.connectionId,row.id));
      await store.use(a.context,row.id,c=>c.getCurrentUser());expect(t.grants).toHaveLength(2);
    } finally {transaction.mockRestore();}
  });

  test('rehydrated runtime skips disabled sibling stores when publishing from an active connection',async()=>{
    const h=setup(transport(),[targetFor()]),{job,pipeline}=await simulation(h),other=await create(h,a,'LOCAL_FIXTURE');
    await h.manager.reconcile();await h.service.disable(a.context,other.id);
    createApp({db:a.db,runtime:h.runtime,security,siteverifyFetch:async()=>Response.json({success:true,hostname:'example.com'})});
    await pipeline.runOnce();const [stored]=await a.db.select().from(pipelineJobs).where(eq(pipelineJobs.id,job.processingId));
    if(stored!.orderId)a.trackOrder(stored!.orderId);expect(stored!.state).toBe('SUCCEEDED');
  });

  test('disable while callback exchanges code prevents pending-token resurrection and subsequent identity HTTP',async()=>{
    const t=transport(),run=t.run,entered=latch(),release=latch();
    t.run=async request=>{if(request.method==='POST'){entered.resolve();await release.promise;}return run(request);};
    const h=setup(t),auth=await login(),row=await create(h),start=await h.service.start(auth.session,row.id),state=new URL(start.authorizationUrl).searchParams.get('state')!,user=accountId();
    const callback=h.service.callback(`${settings.redirectUri}?state=${state}&code=code:${user}:synthetic`);await entered.promise;
    await h.service.disable(a.context,row.id);release.resolve();await expect(callback).rejects.toBeDefined();
    expect(t.grants).toHaveLength(1);expect(t.reads).toHaveLength(0);
    const [attempt]=await a.db.select().from(connectionAuthorizations).where(eq(connectionAuthorizations.id,start.attemptId));expect(attempt!.status).toBe('FAILED');expect(attempt!.envelope).toBeNull();
    await expect(h.service.confirm(auth.session,row.id,start.attemptId)).rejects.toBeDefined();
  });
});
