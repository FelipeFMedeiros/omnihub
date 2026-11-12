// Comando explicito: cria no maximo um vendedor e um comprador por arquivo local.
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { MeliClient, readMeliTokens, tokenFile, writeMeliTokens } from '../src';
const clientId = process.env.MELI_APP_ID ?? '';
const bootstrap = 'output/meli/bootstrap-tokens.json';
const tokens = await readMeliTokens(await Bun.file(bootstrap).exists() ? bootstrap : tokenFile, clientId);
if (!tokens) throw new Error('Autorize a aplicacao antes de criar usuarios.');
const client = new MeliClient({ clientId, clientSecret:process.env.MELI_CLIENT_SECRET ?? '', initialTokens: tokens, onTokens: t => writeMeliTokens('output/meli/bootstrap-tokens.json',clientId,t) });
type User = { id:string; nickname:string; password:string; site_status:string };
const path = 'output/meli/test-users.json';
await mkdir('output/meli',{recursive:true});
const users: {seller?:User;buyer?:User} = await Bun.file(path).exists() ? await Bun.file(path).json() as {seller?:User;buyer?:User} : {};
if (!await Bun.file(bootstrap).exists()) await writeFile(bootstrap, JSON.stringify({ version:1,clientId,tokens },null,2), { mode:0o600, flag:'wx' });
for (const role of ['seller','buyer'] as const) {
  if (!users[role]) {
    try { users[role] = await client.createTestUser(); }
    catch (error) { console.log(JSON.stringify({ role,created:false,code:error && typeof error==='object' && 'code' in error ? error.code : 'FAILED',status:error && typeof error==='object' && 'status' in error ? error.status : null })); process.exit(1); }
    const temporary = `${path}.tmp`; await writeFile(temporary,JSON.stringify(users,null,2),{mode:0o600}); await rename(temporary,path);
  }
  console.log(JSON.stringify({role,created:true,status:users[role]!.site_status,privateValuesPrinted:false}));
}
let env = await Bun.file('.env').text();
for (const [key,role] of [['MELI_TEST_SELLER_ID','seller'],['MELI_TEST_BUYER_ID','buyer']] as const) {
  const re = new RegExp(`^${key}=.*$`,'m'); env = re.test(env) ? env.replace(re,`${key}=${users[role]!.id}`) : `${env.trimEnd()}\n${key}=${users[role]!.id}\n`;
}
await Bun.write('.env',env);
console.log(JSON.stringify({localEnvironmentUpdated:true,credentialsFile:path,privateValuesPrinted:false}));
