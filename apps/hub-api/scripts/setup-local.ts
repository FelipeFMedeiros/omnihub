import { randomBytes } from 'node:crypto';
const file = Bun.file(new URL('../../../.env', import.meta.url));
if (!await file.exists()) throw new Error('Copie .env.example para .env antes de configurar o ambiente local.');
let text = await file.text(); const added: string[] = [];
for (const key of ['HUB_ADMIN_TOKEN', 'MOCK_ERP_ADMIN_TOKEN', 'ERP_WEBHOOK_SECRET']) {
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
  if (match?.[1]?.trim() && !/SUBSTITUIR|PLACEHOLDER/.test(match[1])) continue;
  const line = `${key}=${randomBytes(32).toString('base64url')}`;
  text = match ? text.replace(new RegExp(`^${key}=.*$`, 'm'), line) : `${text.trimEnd()}\n${line}\n`; added.push(key);
}
if (!/^HUB_ERP_WEBHOOK_URL=/m.test(text)) text = `${text.trimEnd()}\nHUB_ERP_WEBHOOK_URL=http://127.0.0.1:3000/api/webhooks/erp-stock\n`;
await Bun.write(file, text);
console.log(JSON.stringify({ configured: true, addedKeys: added, privateValuesPrinted: false }));
