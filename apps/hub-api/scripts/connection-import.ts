import { createDatabase } from '@omnihub/database';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { CredentialCipher } from '../src/services/credential-cipher';
import { ConnectionCredentialStore } from '../src/services/connection-credentials';
import { importConnection } from '../src/services/connection-import';

const args = process.argv.slice(2);
const arg = (name: string) => { const index = args.indexOf(name); if (index < 0 || !args[index+1] || args[index+1]!.startsWith('--')) throw new Error('Explicit import arguments required'); return args[index+1]!; };
if (!args.includes('--confirm-import')) throw new Error('Explicit --confirm-import required');
const input = { workspaceId: arg('--workspace'), connectionId: arg('--connection'), verifiedOwnerId: arg('--verified-owner'), expectedAccountId: arg('--expected-account'), source: arg('--source'), verificationReference: arg('--verification-reference') };
const report = resolve(arg('--report'));
if (await Bun.file(report).exists()) throw new Error('Choose a new report path; existing evidence must be preserved');
await mkdir(dirname(report), { recursive: true });
const { db, client } = createDatabase();
try {
  const settings = { clientId: process.env.MELI_APP_ID!, clientSecret: process.env.MELI_CLIENT_SECRET!, redirectUri: process.env.MELI_REDIRECT_URI!, publicHubUrl: process.env.PUBLIC_HUB_URL!, returnUrl: new URL('/connections', process.env.PUBLIC_DASHBOARD_URL!).toString() };
  const store = new ConnectionCredentialStore(db, await CredentialCipher.fromFile(process.env.CONNECTION_KEYS_FILE!), settings);
  const result = await importConnection(store, input);
  await writeFile(report, JSON.stringify(result, null, 2)+'\n', { flag: 'wx' });
  console.log('Official identity verified and explicit encrypted import persisted; sanitized report saved.');
} catch {
  console.error('Connection import failed; no credentials or upstream response printed.'); process.exitCode = 1;
} finally { await client.end(); }
