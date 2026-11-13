import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { HubError } from '../errors';

export interface CipherScope { workspaceId: string; connectionId: string; appId: string; purpose: string }
const invalid = () => new HubError(503, 'CREDENTIAL_UNAVAILABLE', 'Credencial indisponível; confira as chaves privadas ou refaça a autorização.');
export class CredentialCipher {
  constructor(readonly activeVersion: string, private readonly keys: ReadonlyMap<string, Buffer>) {
    if (!keys.has(activeVersion) || [...keys].some(([version, key]) => !/^[a-zA-Z0-9_-]{1,30}$/.test(version) || key.length !== 32)) throw invalid();
  }
  static async fromFile(path: string) {
    try {
      const data: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!data || typeof data !== 'object' || !('activeVersion' in data) || typeof data.activeVersion !== 'string' || !('keys' in data) || !data.keys || typeof data.keys !== 'object') throw invalid();
      const keys = new Map<string, Buffer>();
      for (const [version, value] of Object.entries(data.keys)) {
        if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw invalid();
        keys.set(version, Buffer.from(value, 'base64'));
      }
      return new CredentialCipher(data.activeVersion, keys);
    } catch { throw invalid(); }
  }
  private aad(scope: CipherScope, version: string) { return Buffer.from(JSON.stringify(['omnihub-credentials', 1, version, scope.workspaceId, scope.connectionId, scope.appId, scope.purpose])); }
  seal(value: unknown, scope: CipherScope): string {
    const version = this.activeVersion, nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(version)!, nonce);
    cipher.setAAD(this.aad(scope, version));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return JSON.stringify({ format: 1, version, nonce: nonce.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') });
  }
  open(envelope: string, scope: CipherScope): unknown {
    try {
      if (envelope.length > 65536) throw invalid();
      const data = JSON.parse(envelope) as Record<string, unknown>;
      if (data.format !== 1 || typeof data.version !== 'string' || typeof data.nonce !== 'string' || typeof data.tag !== 'string' || typeof data.ciphertext !== 'string') throw invalid();
      const key = this.keys.get(data.version), nonce = Buffer.from(data.nonce, 'base64url'), tag = Buffer.from(data.tag, 'base64url');
      if (!key || nonce.length !== 12 || tag.length !== 16) throw invalid();
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(this.aad(scope, data.version)); decipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data.ciphertext, 'base64url')), decipher.final()]).toString('utf8')) as unknown;
    } catch { throw invalid(); }
  }
}
