import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir,'../../..'), output = resolve(root,'output/task-013');
await mkdir(output,{ recursive: true });
const results: { command: string; exitCode: number; output: string }[] = [];
async function run(name: string, args: string[]) {
  const process = Bun.spawn(args,{ cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [stdout,stderr,exitCode] = await Promise.all([new Response(process.stdout).text(),new Response(process.stderr).text(),process.exited]);
  const content = `${stdout}${stderr}`;
  await writeFile(resolve(output,`${name}.txt`),content);
  results.push({ command: args.join(' '), exitCode, output: `${name}.txt` });
  if (exitCode !== 0) throw new Error(`${name} failed; see its captured output`);
  console.log(`${name}: passed`);
  return content;
}
try {
  // This reset is opt-in and has its own exact database-name/URL guard before connecting.
  if (process.argv.includes('--rehearse-upgrade')) await run('upgrade',['bun','--env-file=.env','packages/database/scripts/verify-task013-upgrade.ts','--reset-task013-test','--fresh-after-upgrade']);
  await run('schema-generation',['bun','run','db:generate']);
  await run('dev-migration',['bun','run','db:migrate']);
  await run('dev-seed-first',['bun','run','db:seed']);
  await run('dev-seed-second',['bun','run','db:seed']);
  const checked = await Promise.allSettled([
    run('typecheck',['bun','run','typecheck']), run('tests',['bun','test']),
  ]);
  const rejected = checked.find(r => r.status === 'rejected');
  if (rejected?.status === 'rejected') throw rejected.reason;
  const tests = checked[1];
  if (tests?.status !== 'fulfilled') throw new Error('Test output unavailable');
  const count = (label: string) => { const match = tests.value.match(new RegExp(`^\\s*(\\d+) ${label}\\s*$`,'m')); return match ? Number(match[1]) : 0; };
  const summary = tests.value.match(/Ran (\d+) tests across (\d+) files/);
  if (!summary || count('fail') !== 0 || count('skip') !== 0) throw new Error('Tests must have a real summary and zero failures/skips');
  await run('openapi-export',['bun','run','api:openapi']);
  await run('diff-check',['git','diff','--check']);
  await writeFile(resolve(output,'verification.json'),JSON.stringify({ checkedAt: new Date().toISOString(), results, tests: { passed: count('pass'), failed: count('fail'), skipped: count('skip'), total: Number(summary[1]), files: Number(summary[2]), assertions: Number(tests.value.match(/(\d+) expect\(\) calls/)?.[1] ?? 0) } },null,2));
} catch (error) {
  await writeFile(resolve(output,'verification-failed.json'),JSON.stringify({ checkedAt: new Date().toISOString(), results },null,2));
  throw error;
}
