import { createDatabase } from '@omnihub/database';
import { claimLegacy } from '../src/services/legacy-claim.service';

const args = process.argv.slice(2);
function required(flag: string) {
  const position = args.indexOf(flag), value = position >= 0 ? args[position + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`Required explicit ${flag}`);
  return value;
}
if (!args.includes('--confirm-claim')) throw new Error('Explicit --confirm-claim required after independent owner verification');
const input = { legacyWorkspaceId: required('--legacy-workspace'), emptyWorkspaceId: required('--empty-workspace'), verifiedOwnerId: required('--verified-owner'), verificationReference: required('--verification-reference') };
for (const id of [input.legacyWorkspaceId,input.emptyWorkspaceId,input.verifiedOwnerId]) if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid explicit UUID target');
const { db, client } = createDatabase();
try { console.log(JSON.stringify(await claimLegacy(db, input))); }
finally { await client.end(); }
