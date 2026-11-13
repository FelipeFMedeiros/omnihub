import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Captures real exit codes and unmodified stdout/stderr; never prints the private environment.
const stamp = new Date().toISOString().replaceAll(/[:.]/g,'-');
const folder = resolve('output/task-014', `checks-${stamp}`);
await mkdir(folder, { recursive: true });
const checks = [
  ['typecheck', ['bun', 'run', 'typecheck']],
  ['tests', ['bun', 'test']],
  ['openapi', ['bun', 'run', 'api:openapi']],
  ['generate', ['bun', 'run', 'db:generate']],
  ['diff-check', ['git', 'diff', '--check']],
] as const;
const results: { name: string; command: readonly string[]; exitCode: number; stdout: string; stderr: string; counts?: Record<string, number> }[] = [];
for (const [name, command] of checks) {
  const proc = Bun.spawn([...command], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
  await writeFile(`${folder}/${name}.stdout.log`, stdout);
  await writeFile(`${folder}/${name}.stderr.log`, stderr);
  const result: typeof results[number] = { name, command, exitCode, stdout: `${name}.stdout.log`, stderr: `${name}.stderr.log` };
  if (name === 'tests') {
    const combined = `${stdout}\n${stderr}`;
    const match = (pattern: RegExp) => { const found = combined.match(pattern); return found ? Number(found[1]) : 0; };
    result.counts = { pass:match(/(\d+) pass/),fail:match(/(\d+) fail/),skip:match(/(\d+) skip/),assertions:match(/(\d+) expect\(\) calls/),files:match(/across (\d+) files/) };
  }
  results.push(result);
  console.log(`${name}: exit ${exitCode}${result.counts ? `; ${JSON.stringify(result.counts)}` : ''}`);
}
await writeFile(`${folder}/checks.json`,JSON.stringify({ checkedAt:new Date().toISOString(),results },null,2)+'\n');
console.log(`Recorded ${folder}`);
if (results.some(r => r.exitCode !== 0)) process.exitCode = 1;
