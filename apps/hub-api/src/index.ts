import { createDatabase } from '@omnihub/database';
import { createApp } from './app';
import { loadEnv } from './config/env';

const config = loadEnv();
const { db, client } = createDatabase(config.databaseUrl, config.databasePoolSize);
const app = createApp({ db, corsOrigins: config.corsOrigins });

try {
  app.listen({ hostname: config.host, port: config.port });
} catch (error) {
  await client.end();
  throw error;
}
console.log(`Omnihub API em http://${config.host}:${config.port} — documentação em /docs`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await app.stop();
  await client.end();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
