import { createDatabase } from '@omnihub/database';
import { createApp } from './app';
import { loadEnv } from './config/env';
import { createRuntime } from './config/runtime';
import { loadSecurityEnv } from './config/security';

const config = loadEnv();
const security = loadSecurityEnv();
const { db, client } = createDatabase(config.databaseUrl, config.databasePoolSize);
const runtime = await createRuntime(db);
const app = createApp({ db, corsOrigins: config.corsOrigins, runtime, security });

try {
  app.listen({ hostname: config.host, port: config.port, maxRequestBodySize: 1024 * 1024 });
  runtime.pipeline?.start();
} catch (error) {
  await client.end();
  throw error;
}
console.log(`Omnihub API em http://${config.host}:${config.port} — documentação em /docs`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await runtime.pipeline?.stop();
  await app.stop();
  await client.end();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
