import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { createDatabase } from '@omnihub/database';

const root = resolve('.'), stamp = new Date().toISOString().replaceAll(/[:.]/g,'-');
const folder = resolve('output/task-014', `source-${stamp}`);
const git = async (...args: string[]) => {
  const proc = Bun.spawn(['git', ...args], { stdout:'pipe',stderr:'pipe' });
  const [stdout,stderr,code] = await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
  if (code !== 0) throw new Error('Git evidence collection failed');
  return {stdout,stderr};
};
const tracked = (await git('ls-files','-z')).stdout.split('\0').filter(Boolean);
const untracked = (await git('ls-files','--others','--exclude-standard','-z')).stdout.split('\0').filter(Boolean);
const files = [...new Set([...tracked,...untracked])].sort();
const changed = new Set([...(await git('diff','--name-only','-z')).stdout.split('\0').filter(Boolean),...untracked]);
await mkdir(`${folder}/source`,{recursive:true});
const manifest: { path:string; bytes:number; sha256:string; changed:boolean; previouslyUntracked:boolean }[]=[];
const whitespace: { path:string; line:number; issue:string }[]=[];
for (const path of files) {
  if (/(^|\/)(\.env(?!\.example)|\.git|node_modules|output)(\/|$)/.test(path) || /(?:^|\/)(?:tokens|bootstrap-tokens)\.json$/.test(path)) throw new Error('Private path in source inventory');
  const source = resolve(root,path), target = resolve(folder,'source',path);
  if (relative(root,source).startsWith('..') || relative(`${folder}/source`,target).startsWith('..')) throw new Error('Source path escaped');
  const bytes = await readFile(source);
  await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes,{flag:'wx'});
  manifest.push({path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),changed:changed.has(path),previouslyUntracked:untracked.includes(path)});
  if (changed.has(path) && !bytes.includes(0)) {
    const text=bytes.toString('utf8'),lines=text.split(/\r?\n/);
    lines.forEach((line,index)=>{if(/[ \t]+$/.test(line))whitespace.push({path,line:index+1,issue:'trailing whitespace'});});
    if (/\n\s*\n$/.test(text))whitespace.push({path,line:lines.length,issue:'extra blank line at EOF'});
  }
}
await writeFile(`${folder}/whitespace.json`,JSON.stringify({checkedFiles:changed.size,violations:whitespace},null,2)+'\n');
if (whitespace.length) throw new Error('Changed/new source whitespace check failed; see whitespace.json');
const [head,branch,status,diff] = await Promise.all([git('rev-parse','HEAD'),git('branch','--show-current'),git('status','--short'),git('diff','--binary')]);
await writeFile(`${folder}/git-status.txt`,status.stdout);await writeFile(`${folder}/git-diff.patch`,diff.stdout);
const sourceDigest=createHash('sha256').update(manifest.map(f=>`${f.path}\0${f.sha256}\n`).join('')).digest('hex');
await writeFile(`${folder}/manifest.json`,JSON.stringify({capturedAt:new Date().toISOString(),base:head.stdout.trim(),branch:branch.stdout.trim(),sourceDigest,files:manifest},null,2)+'\n');
const databaseNames:Record<string,unknown>={};
for(const [label,url] of [['dev',process.env.DATABASE_URL],['test',process.env.TEST_DATABASE_URL]] as const){
  if (!url || new URL(url).pathname !== (label==='dev'?'/omnihub_task014_dev':'/omnihub_task014_test_db')) throw new Error('Unexpected database evidence target');
  const {client}=createDatabase(url,1);
  try{
    const [name]=await client`SELECT current_database() AS name, current_setting('server_version') AS version`;
    const counts:Record<string,number>={};
    for(const table of ['users','workspaces','connections','connection_credentials','connection_authorizations','connection_imports','products','canonical_orders','inventory_ledger','pipeline_jobs','erp_dispatches','erp_attempts']){
      const [row]=await client.unsafe(`SELECT count(*)::int AS total FROM ${table}`);counts[table]=row?.total as number;
    }
    const [migrations]=await client`SELECT count(*)::int AS applied FROM drizzle.__drizzle_migrations`;
    databaseNames[label]={...name,appliedMigrations:migrations?.applied,rowCounts:counts};
  }finally{await client.end();}
}
await writeFile(`${folder}/public-environment.json`,JSON.stringify({bun:Bun.version,node:process.version,NODE_ENV:process.env.NODE_ENV,PUBLIC_HUB_URL:process.env.PUBLIC_HUB_URL,PUBLIC_DASHBOARD_URL:process.env.PUBLIC_DASHBOARD_URL,CORS_ORIGINS:process.env.CORS_ORIGINS,connectionsEnabled:process.env.CONNECTIONS_ENABLED==='true',cipher:'AES-256-GCM',keyMaterialExcluded:true,keysOutsideWorktree:Boolean(process.env.CONNECTION_KEYS_FILE&&!resolve(process.env.CONNECTION_KEYS_FILE).startsWith(root)),erpTargetsFileConfigured:Boolean(process.env.ERP_TARGETS_FILE),marketplaceConfigurationPresent:['MELI_APP_ID','MELI_CLIENT_SECRET','MELI_REDIRECT_URI'].every(k=>Boolean(process.env[k])),databases:databaseNames,officialWritesExecuted:false,listenerStarted:false},null,2)+'\n');
await writeFile('output/task-014/latest-source.json',JSON.stringify({folder,sourceDigest,capturedFiles:manifest.length,changedFiles:changed.size},null,2)+'\n');
console.log(`Packaged ${manifest.length} exact source files (${changed.size} changed/new); SHA-256 ${sourceDigest}; whitespace passed.`);
