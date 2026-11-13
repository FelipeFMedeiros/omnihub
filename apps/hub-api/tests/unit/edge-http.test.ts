import { expect, test } from 'bun:test';
import { createDatabase } from '@omnihub/database';
import { createApp } from '../../src/app';
import { loadSecurityEnv } from '../../src/config/security';

const config = loadSecurityEnv({ NODE_ENV: 'test', PUBLIC_HUB_URL: 'https://hub.example.com', CORS_ORIGINS: 'http://localhost:5173',
  JWT_SECRET: 'edge-only-test-key-'.repeat(4), CLOUDFLARE_TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' });

test('webhook mantém limite 500/s, sem cookie/Origin/Turnstile e com HMAC antes do JSON', async () => {
  const { db, client } = createDatabase('postgresql://localhost/not_connected');
  let verifications = 0;
  try {
    const app = createApp({ db, security: config, siteverifyFetch:async()=>{verifications++;return Response.json({success:false});},
      runtime:{adminToken:'a'.repeat(40),webhookSecret:'h'.repeat(40),erpUrl:'http://127.0.0.1:3306',mockAdminToken:'a'.repeat(40)} });
    const responses = await Promise.all(Array.from({length:501},()=>app.handle(new Request('http://localhost/api/webhooks/erp-stock/',{
      method:'POST',headers:{'x-erp-signature':'invalid'},body:'{invalid-json',
    }))));
    expect(responses.filter(r=>r.status===403)).toHaveLength(500);
    expect(responses.filter(r=>r.status===429)).toHaveLength(1);
    expect(await responses[0]!.json()).toMatchObject({error:{code:'INVALID_ERP_SIGNATURE'}});
    expect(responses[500]!.headers.get('retry-after')).toBe('1');
    expect(verifications).toBe(0);
  } finally { await client.end(); }
});

test('socket real em porta efêmera ignora spoof de proxy; configuração explícita distingue clientes', async () => {
  const {db,client}=createDatabase('postgresql://localhost/not_connected');
  async function exercise(trusted: boolean) {
    const app = createApp({db, security:{...config,trustedProxyIps:trusted?['127.0.0.1']:[]}}).listen({hostname:'127.0.0.1',port:0});
    try {
      const url = `http://127.0.0.1:${app.server!.port}/api/auth/login`;
      for(let i=0;i<11;i++) {
        const response = await fetch(url,{method:'POST',headers:{origin:'http://localhost:5173','content-type':'application/json','cf-connecting-ip':`192.0.2.${i+1}`,'x-forwarded-for':`198.51.100.${i+1}`},body:JSON.stringify({email:'nobody@example.invalid',password:'wrong'})});
        expect(response.status).toBe(!trusted&&i===10?429:403);
        await response.body?.cancel();
      }
    } finally { await app.stop(); }
  }
  try { await exercise(false); await exercise(true); }
  finally { await client.end(); }
});
