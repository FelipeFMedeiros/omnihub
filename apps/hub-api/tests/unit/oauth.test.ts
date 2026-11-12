import { expect, test } from 'bun:test';
import { createDatabase } from '@omnihub/database';
import { MeliClient } from '@omnihub/marketplace-adapters';
import { OAuthService } from '../../src/services/oauth.service';
import { createApp } from '../../src/app';

test('OAuth integrado exige admin no inicio, valida state e impede replay no callback publico', async () => {
  let exchanges = 0, persisted = false;
  const client = new MeliClient({ clientId: '123456', clientSecret: 'test-only-secret', transport: async () => { exchanges++; return Response.json({ access_token:'test-access', refresh_token:'test-refresh', user_id:900000001, token_type:'Bearer',expires_in:3600 }); }, onTokens: async () => { persisted=true; } });
  const oauth = new OAuthService(client,{ clientId:'123456',redirectUri:'https://callback.example.invalid/api/oauth/meli/callback',pkce:true });
  const connection = createDatabase('postgresql://unused:unused@127.0.0.1:1/unused_test');
  const token = 'local-test-admin-'.repeat(3);
  const app = createApp({ db:connection.db,runtime:{ adminToken:token,webhookSecret:'',erpUrl:'http://127.0.0.1:3002',mockAdminToken:'',oauth } });
  try {
    expect((await app.handle(new Request('http://localhost/api/oauth/meli/start',{method:'POST'}))).status).toBe(401);
    const response = await app.handle(new Request('http://localhost/api/oauth/meli/start',{method:'POST',headers:{authorization:`Bearer ${token}`}}));
    expect(response.status).toBe(200);
    const auth = await response.json() as { authorizationUrl:string }; const state = new URL(auth.authorizationUrl).searchParams.get('state')!;
    const callback = 'http://localhost/api/oauth/meli/callback?code=test-code&state=';
    expect((await app.handle(new Request(callback+'wrong'))).status).toBe(400); expect(exchanges).toBe(0);
    const complete = await app.handle(new Request(callback+state)); expect(complete.status).toBe(200); expect(persisted).toBe(true); expect(complete.headers.get('cache-control')).toBe('no-store');
    expect((await app.handle(new Request(callback+state))).status).toBe(400); expect(exchanges).toBe(1);
  } finally { await connection.client.end(); }
});
