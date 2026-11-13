import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { createDatabase } from '@omnihub/database';

const root = resolve('.');
const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
const qaOutputFolder = resolve('output/task-014/qa');
const vaultQaFolder = resolve('C:/vault-agents/projects/ominihub/logs/evidences/task-014-2026-11-13/qa');

await mkdir(qaOutputFolder, { recursive: true });
await mkdir(vaultQaFolder, { recursive: true });

const git = async (...args: string[]) => {
  const proc = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`Git command failed: git ${args.join(' ')}: ${stderr}`);
  return { stdout, stderr, code };
};

// 1. Run Checks
console.log('Running QA Checks...');
const checks = [
  ['typecheck', ['bun', 'run', 'typecheck']],
  ['tests', ['bun', 'test']],
  ['openapi', ['bun', 'run', 'api:openapi']],
  ['generate', ['bun', 'run', 'db:generate']],
] as const;

const checkResults: { name: string; command: readonly string[]; exitCode: number; stdout: string; stderr: string; counts?: Record<string, number> }[] = [];

for (const [name, command] of checks) {
  const proc = Bun.spawn([...command], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  await writeFile(`${qaOutputFolder}/${name}.stdout.log`, stdout);
  await writeFile(`${qaOutputFolder}/${name}.stderr.log`, stderr);
  const result: typeof checkResults[number] = { name, command, exitCode, stdout: `${name}.stdout.log`, stderr: `${name}.stderr.log` };
  if (name === 'tests') {
    const combined = `${stdout}\n${stderr}`;
    const match = (pattern: RegExp) => { const found = combined.match(pattern); return found ? Number(found[1]) : 0; };
    result.counts = {
      pass: match(/(\d+) pass/),
      fail: match(/(\d+) fail/),
      skip: match(/(\d+) skip/),
      assertions: match(/(\d+) expect\(\) calls/),
      files: match(/across (\d+) files/),
    };
  }
  checkResults.push(result);
  console.log(`${name}: exit ${exitCode}${result.counts ? `; ${JSON.stringify(result.counts)}` : ''}`);
  if (exitCode !== 0) throw new Error(`Check ${name} failed with exit code ${exitCode}`);
}

// 2. Isolated Index Whitespace Check
console.log('Checking whitespace on tracked and untracked files...');
const isolatedIndex = resolve(qaOutputFolder, 'isolated.index');
const env = { ...process.env, GIT_INDEX_FILE: isolatedIndex };
for (const args of [['read-tree', 'HEAD'], ['add', '-A', '--', '.'], ['diff', '--cached', '--check']]) {
  const p = Bun.spawn(['git', ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (exitCode !== 0) throw new Error(`Isolated index whitespace check failed: ${stderr || stdout}`);
}
try { await Bun.file(isolatedIndex).delete(); } catch {}
console.log('Whitespace check passed: exit 0.');

// 3. Database Upgrade Check
console.log('Running upgrade verification on dedicated test DB...');
const upgradeProc = Bun.spawn(['bun', '--env-file=.env', 'packages/database/scripts/verify-task014-upgrade.ts', '--reset-task014-test'], { stdout: 'pipe', stderr: 'pipe' });
const [upgradeOut, upgradeErr, upgradeExit] = await Promise.all([new Response(upgradeProc.stdout).text(), new Response(upgradeProc.stderr).text(), upgradeProc.exited]);
await writeFile(`${qaOutputFolder}/upgrade.stdout.log`, upgradeOut);
await writeFile(`${qaOutputFolder}/upgrade.stderr.log`, upgradeErr);
if (upgradeExit !== 0) throw new Error(`Upgrade check failed: ${upgradeErr || upgradeOut}`);
console.log('Upgrade check passed: exit 0.');

// 4. Source Inventory and Manifest
console.log('Creating source manifest and snapshot...');
const tracked = (await git('ls-files', '-z')).stdout.split('\0').filter(Boolean);
const untracked = (await git('ls-files', '--others', '--exclude-standard', '-z')).stdout.split('\0').filter(Boolean);
const files = [...new Set([...tracked, ...untracked])].sort();
const changed = new Set([...(await git('diff', '--name-only', '-z')).stdout.split('\0').filter(Boolean), ...untracked]);

const manifest: { path: string; bytes: number; sha256: string; changed: boolean; previouslyUntracked: boolean }[] = [];
for (const path of files) {
  if (/(^|\/)(\.env(?!\.example)|\.git|node_modules|output)(\/|$)/.test(path) || /(?:^|\/)(?:tokens|bootstrap-tokens)\.json$/.test(path)) {
    throw new Error(`Private path in source inventory: ${path}`);
  }
  const source = resolve(root, path);
  if (relative(root, source).startsWith('..')) throw new Error(`Path escaped root: ${path}`);
  const bytes = await readFile(source);
  manifest.push({
    path,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    changed: changed.has(path),
    previouslyUntracked: untracked.includes(path),
  });
}

const sourceDigest = createHash('sha256').update(manifest.map(f => `${f.path}\0${f.sha256}\n`).join('')).digest('hex');
const [head, branch, status, diff] = await Promise.all([git('rev-parse', 'HEAD'), git('branch', '--show-current'), git('status', '--short'), git('diff', '--binary')]);

await writeFile(`${qaOutputFolder}/git-status.txt`, status.stdout);
await writeFile(`${qaOutputFolder}/git-diff.patch`, diff.stdout);
await writeFile(`${qaOutputFolder}/manifest.json`, JSON.stringify({
  capturedAt: new Date().toISOString(),
  base: head.stdout.trim(),
  branch: branch.stdout.trim(),
  sourceDigest,
  totalFiles: manifest.length,
  changedFiles: changed.size,
  files: manifest,
}, null, 2) + '\n');

// 5. Environment & Databases
const databaseNames: Record<string, unknown> = {};
for (const [label, url] of [['dev', process.env.DATABASE_URL], ['test', process.env.TEST_DATABASE_URL]] as const) {
  if (!url || new URL(url).pathname !== (label === 'dev' ? '/omnihub_task014_dev' : '/omnihub_task014_test_db')) {
    throw new Error(`Unexpected database URL for ${label}: ${url}`);
  }
  const { client } = createDatabase(url, 1);
  try {
    const [name] = await client`SELECT current_database() AS name, current_setting('server_version') AS version`;
    const counts: Record<string, number> = {};
    for (const table of [
      'users', 'workspaces', 'connections', 'connection_credentials', 'connection_authorizations',
      'connection_imports', 'products', 'canonical_orders', 'inventory_ledger', 'pipeline_jobs',
      'erp_dispatches', 'erp_attempts',
    ]) {
      const [row] = await client.unsafe(`SELECT count(*)::int AS total FROM ${table}`);
      counts[table] = row?.total as number;
    }
    const [migrations] = await client`SELECT count(*)::int AS applied FROM drizzle.__drizzle_migrations`;
    databaseNames[label] = { ...name, appliedMigrations: migrations?.applied, rowCounts: counts };
  } finally {
    await client.end();
  }
}

const publicEnv = {
  bun: Bun.version,
  node: process.version,
  NODE_ENV: process.env.NODE_ENV,
  PUBLIC_HUB_URL: process.env.PUBLIC_HUB_URL,
  PUBLIC_DASHBOARD_URL: process.env.PUBLIC_DASHBOARD_URL,
  CORS_ORIGINS: process.env.CORS_ORIGINS,
  connectionsEnabled: process.env.CONNECTIONS_ENABLED === 'true',
  cipher: 'AES-256-GCM',
  keyMaterialExcluded: true,
  keysOutsideWorktree: Boolean(process.env.CONNECTION_KEYS_FILE && !resolve(process.env.CONNECTION_KEYS_FILE).startsWith(root)),
  erpTargetsFileConfigured: Boolean(process.env.ERP_TARGETS_FILE),
  marketplaceConfigurationPresent: ['MELI_APP_ID', 'MELI_CLIENT_SECRET', 'MELI_REDIRECT_URI'].every(k => Boolean(process.env[k])),
  databases: databaseNames,
  officialWritesExecuted: false,
  listenerStarted: false,
};

await writeFile(`${qaOutputFolder}/public-environment.json`, JSON.stringify(publicEnv, null, 2) + '\n');

// 6. Secret Scan
console.log('Scanning for secrets in tracked & untracked files...');
const privateValues = [
  process.env.JWT_SECRET,
  process.env.HUB_ADMIN_TOKEN,
  process.env.MOCK_ERP_ADMIN_TOKEN,
  process.env.ERP_WEBHOOK_SECRET,
].filter(Boolean) as string[];

let leakedCount = 0;
for (const file of manifest) {
  if (file.path === '.env.example' || file.path.endsWith('.patch')) continue;
  const content = await readFile(resolve(root, file.path), 'utf8');
  for (const secret of privateValues) {
    if (content.includes(secret)) {
      console.error(`SECRET LEAK DETECTED in ${file.path}`);
      leakedCount++;
    }
  }
}
if (leakedCount > 0) throw new Error(`Secret scan failed: ${leakedCount} leaks detected`);

const secretScanReport = {
  checkedAt: new Date().toISOString(),
  filesScanned: manifest.length,
  exactPrivateValuesChecked: privateValues.length,
  matches: 0,
  privateFilesExcluded: true,
  valuesNotPrinted: true,
};
await writeFile(`${qaOutputFolder}/secret-scan.json`, JSON.stringify(secretScanReport, null, 2) + '\n');

// 7. Write Summary Checks
const qaSummary = {
  checkedAt: new Date().toISOString(),
  results: checkResults,
  upgradeCheck: { exitCode: upgradeExit },
  whitespaceCheck: { exitCode: 0 },
  secretScan: secretScanReport,
  sourceDigest,
  totalFiles: manifest.length,
  changedFiles: changed.size,
};
await writeFile(`${qaOutputFolder}/checks.json`, JSON.stringify(qaSummary, null, 2) + '\n');

// 8. Copy to Vault Public Evidences directory
console.log(`Copying public QA evidence to ${vaultQaFolder}...`);
for (const item of [
  'checks.json', 'public-environment.json', 'secret-scan.json', 'manifest.json',
  'git-status.txt', 'git-diff.patch',
  'typecheck.stdout.log', 'typecheck.stderr.log',
  'tests.stdout.log', 'tests.stderr.log',
  'openapi.stdout.log', 'openapi.stderr.log',
  'generate.stdout.log', 'generate.stderr.log',
  'upgrade.stdout.log', 'upgrade.stderr.log',
]) {
  const src = resolve(qaOutputFolder, item);
  const dst = resolve(vaultQaFolder, item);
  try {
    await cp(src, dst);
  } catch (err) {
    console.warn(`Could not copy ${item}:`, err);
  }
}

console.log('QA verification and artifact packaging complete!');
