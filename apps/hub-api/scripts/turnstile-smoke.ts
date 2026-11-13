import { mkdir, writeFile } from 'node:fs/promises';
import { loadSecurityEnv } from '../src/config/security';
import { createTurnstileVerifier, type SiteverifyFetch } from '../src/plugins/turnstile';

const config = loadSecurityEnv();
if (config.production || config.turnstileSecret !== '1x0000000000000000000000000000000AA') throw new Error('Smoke permitido somente com a chave dummy pública autorizada.');
const observations: { success: boolean; hostname: string | null; actionPresent: boolean; cdataPresent: boolean; errorCodes: string[] }[] = [];
const transport: SiteverifyFetch = async (url, init) => {
  const response = await fetch(url, init);
  const value: unknown = await response.clone().json();
  if (value && typeof value === 'object') {
    observations.push({
      success: 'success' in value && value.success === true,
      hostname: 'hostname' in value && typeof value.hostname === 'string' ? value.hostname : null,
      actionPresent: 'action' in value, cdataPresent: 'cdata' in value,
      errorCodes: 'error-codes' in value && Array.isArray(value['error-codes']) ? value['error-codes'].filter((v): v is string => typeof v === 'string') : [],
    });
  }
  return response;
};
const verify = createTurnstileVerifier(config, transport);
const first = await verify('XXXX.DUMMY.TOKEN.XXXX', undefined, { action: 'login' });
const repeat = await verify('XXXX.DUMMY.TOKEN.XXXX', undefined, { action: 'login' });
const report = {
  task: 'TASK-005', at: new Date().toISOString(), endpoint: 'Cloudflare official siteverify',
  mode: 'PUBLIC_DUMMY_KEY', calls: observations.length, first, repeat, observations,
  limitation: 'Dummy always-pass does not demonstrate production replay protection or antibot efficacy. Expiry/reuse failures and real hostname/action/cdata rules are tested with injected responses.',
};
await mkdir('output/task-005', { recursive: true });
await writeFile('output/task-005/siteverify-smoke.json', JSON.stringify(report, null, 2)+'\n');
console.log(JSON.stringify(report));
if (!first || observations[0]?.hostname !== 'example.com' || observations[0]?.actionPresent || observations[0]?.cdataPresent) process.exitCode = 1;
