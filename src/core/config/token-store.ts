import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProviderError } from '../provider/errors.js';
import type { ProviderId } from '../provider/capabilities.js';
import { getConfigDir } from './paths.js';
import { writeAtomic } from './atomic-file.js';

export interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scopes: string[];
  userId: string;
  displayName?: string;
  grantedAt: string;
  refreshTokenExpiresAt?: string;
}
interface TokenFile { schemaVersion: 1; providers: Record<string, { accounts: StoredToken[] }> }
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function iso(value: unknown): boolean {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}
export function assertStoredToken(value: unknown): asserts value is StoredToken {
  if (!isRecord(value) || typeof value.accessToken !== 'string' || !value.accessToken.trim()
      || typeof value.userId !== 'string' || !value.userId.trim() || !iso(value.grantedAt)
      || !Array.isArray(value.scopes) || !value.scopes.every(s => typeof s === 'string')
      || ['refreshToken', 'displayName'].some(k => value[k] !== undefined && typeof value[k] !== 'string')
      || ['expiresAt', 'refreshTokenExpiresAt'].some(k => value[k] !== undefined && !iso(value[k]))) {
    throw new ProviderError('Invalid stored token: required fields, scopes or timestamps are invalid');
  }
}
export class TokenStore {
  readonly path: string;
  constructor(private readonly directory = getConfigDir()) { this.path = join(directory, 'tokens.json'); }
  private async read(): Promise<TokenFile> {
    let contents: string;
    try { contents = await readFile(this.path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, providers: {} }; throw error; }
    let value: unknown;
    try { value = JSON.parse(contents); }
    catch { throw new ProviderError('Invalid tokens.json: expected JSON'); }
    if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.providers)) throw new ProviderError('Invalid tokens.json: expected schemaVersion 1 and providers');
    for (const entry of Object.values(value.providers)) {
      if (!isRecord(entry) || !Array.isArray(entry.accounts)) throw new ProviderError('Invalid tokens.json: expected accounts array');
      // Only the active account is consumed in v1. Preserve reserved additional accounts.
      if (entry.accounts.length) assertStoredToken(entry.accounts[0]);
    }
    return value as unknown as TokenFile;
  }
  async loadTokens(provider: ProviderId): Promise<StoredToken | null> { return (await this.read()).providers[provider]?.accounts[0] ?? null; }
  async saveTokens(provider: ProviderId, token: StoredToken): Promise<void> {
    assertStoredToken(token);
    const file = await this.read();
    const accounts = file.providers[provider]?.accounts ?? [];
    accounts[0] = structuredClone(token);
    file.providers[provider] = { accounts };
    await this.write(file);
  }
  async deleteTokens(provider: ProviderId): Promise<void> {
    const file = await this.read();
    if (!(provider in file.providers)) return;
    delete file.providers[provider]; await this.write(file);
  }
  private async write(file: TokenFile): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeAtomic(this.path, `${JSON.stringify(file, null, 2)}\n`);
  }
}
