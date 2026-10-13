import { spawn } from 'node:child_process'
import { release } from 'node:os'
import { createInterface } from 'node:readline'
import type { OAuthInteraction } from '../core/auth/oauth.js'
import { redact } from './output/logging.js'

export function browserCommand (url: string, platform = process.platform, env: NodeJS.ProcessEnv = process.env, kernel = release()): [string, string[]] {
  if (platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
  if (platform === 'darwin') return ['open', [url]]
  if ((env.WSL_INTEROP != null && env.WSL_INTEROP !== '') || (env.WSL_DISTRO_NAME != null && env.WSL_DISTRO_NAME !== '') || /microsoft/i.test(kernel)) return ['explorer.exe', [url]]
  return ['xdg-open', [url]]
}
export async function openBrowser (url: string): Promise<void> {
  const [command, args] = browserCommand(url)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', shell: false })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Browser opener failed')))
  })
}
export function createOAuthInteraction (options: { write?: (text: string) => void, open?: (url: string) => Promise<void>, readLine?: (prompt: string) => Promise<string> } = {}): OAuthInteraction {
  const write = options.write ?? (text => { process.stderr.write(text) })
  return {
    showAuthorizationUrl: async (url, mode) => {
      write(`Open this URL in your browser to authorize sple:\n${url}\n`)
      if (mode === 'loopback') {
        try { await (options.open ?? openBrowser)(url) } catch { write('sple: warning: Could not open the browser; open the URL above manually.\n') }
      }
      write(mode === 'manual' ? 'Complete login in a browser, then paste the redirected URL even if it fails to load.\n' : 'Waiting for authorization...\n')
    },
    promptForRedirectUrl: options.readLine ?? (async prompt => {
      write(redact(prompt))
      const reader = createInterface({ input: process.stdin, terminal: false })
      try { const { value, done } = await reader[Symbol.asyncIterator]().next(); return done === true ? '' : value } finally { reader.close() }
    })
  }
}
