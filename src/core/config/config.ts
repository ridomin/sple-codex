import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { UsageError } from '../provider/errors.js'
import { getConfigDir } from './paths.js'

export interface Config { directory: string, defaultProvider: string, enableFakeProvider: boolean, spotifyClientId?: string, youtubeClientId?: string, googleClientSecret?: string }
export function parseEnv (contents: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const [i, raw] of contents.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (!(line !== '') || line.startsWith('#')) continue
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (match == null) throw new UsageError(`Invalid .env line ${i + 1}`)
    let value = (match[2] as string).trim()
    if (value.startsWith('"') || value.startsWith("'")) {
      if (value.length < 2 || value.at(-1) !== value[0]) throw new UsageError(`Invalid .env line ${i + 1}`)
      value = value.slice(1, -1)
    }
    values[(match[1] as string)] = value
  }
  return values
}
export async function loadConfig (options: { directory?: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, warn?: (message: string) => void } = {}): Promise<Config> {
  const env = options.env ?? process.env
  const directory = options.directory ?? getConfigDir(options.platform ?? process.platform, env)
  const path = join(directory, '.env')
  let file: Record<string, string> = {}
  try {
    const contents = await readFile(path, 'utf8')
    if ((options.platform ?? process.platform) !== 'win32' && Boolean((await stat(path)).mode & 0o077)) options.warn?.(`Warning: ${path} is readable by other users. Run: chmod 600 "${path}"`)
    file = parseEnv(contents)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') options.warn?.(`Failed to load .env: ${(error as Error).message}`)
  }
  const get = (key: string): string | undefined => { const value = (env[key] !== undefined ? env[key] : file[key])?.trim(); return value !== '' ? value : undefined }
  const config: Config = { directory, defaultProvider: get('SPLE_DEFAULT_PROVIDER') ?? 'spotify', enableFakeProvider: get('SPLE_ENABLE_FAKE_PROVIDER') === '1' }
  const spotifyClientId = get('SPLE_SPOTIFY_CLIENT_ID'); const youtubeClientId = get('SPLE_YOUTUBE_MUSIC_CLIENT_ID'); const googleClientSecret = get('SPLE_GOOGLE_CLIENT_SECRET')
  if ((spotifyClientId != null && spotifyClientId !== '')) config.spotifyClientId = spotifyClientId
  if ((youtubeClientId != null && youtubeClientId !== '')) config.youtubeClientId = youtubeClientId
  if ((googleClientSecret != null && googleClientSecret !== '')) config.googleClientSecret = googleClientSecret
  return config
}
