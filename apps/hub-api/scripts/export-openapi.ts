import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createDatabase } from '@omnihub/database';
import { createApp } from '../src/app';
import { loadSecurityEnv } from '../src/config/security';

const target = resolve(process.argv[2] ?? 'docs/integrations/task-013.openapi.json');
const { db, client } = createDatabase();
try {
  // Documentation has no dependency on credentials or a live marketplace/runtime.
  const response = await createApp({ db, security: loadSecurityEnv() }).handle(new Request('http://localhost/docs/json'));
  if (!response.ok) throw new Error('OpenAPI export failed');
  await mkdir(dirname(target), { recursive: true });
  const schema: unknown = await response.json();
  await writeFile(target, `${JSON.stringify(schema,null,2)}\n`);
  console.log('OpenAPI exported from executable routes.');
} finally { await client.end(); }
