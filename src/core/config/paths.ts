import { homedir } from 'node:os'
import { join } from 'node:path'

export function getConfigDir (platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (platform === 'linux') return join(env.XDG_CONFIG_HOME != null && env.XDG_CONFIG_HOME !== '' ? env.XDG_CONFIG_HOME : join(home, '.config'), 'sple')
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'sple')
  if (platform === 'win32' && (env.APPDATA != null && env.APPDATA !== '')) return join(env.APPDATA, 'sple')
  return join(home, '.sple')
}
export function getConfigFilePath (filename: string): string { return join(getConfigDir(), filename) }
