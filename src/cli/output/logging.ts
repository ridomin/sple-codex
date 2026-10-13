import createDebug from 'debug'
import { format } from 'node:util'
import type { HttpLogEntry } from '../../core/http/client.js'

export function redact (value: string): string {
  return value.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(access_token|refresh_token|id_token|code|code_verifier|client_secret)=[^&\s]+/gi, '$1=[REDACTED]')
    .replace(/"(access_token|refresh_token|id_token|client_secret)"\s*:\s*"(?:\\.|[^"\\])*"/gi, '"$1":"[REDACTED]"')
}
export function configureLogging (options: { verbose?: boolean, debug?: boolean, env?: NodeJS.ProcessEnv, write?: (line: string) => void } = {}): void {
  const write = options.write ?? (line => { process.stderr.write(line) })
  createDebug.log = (...args: unknown[]) => write(`${redact(format(...args))}\n`)
  const env = options.env ?? process.env
  const pattern = (options.debug ?? false) ? 'sple:*' : (options.verbose ?? false) ? 'sple:*,-sple:http*' : ''
  createDebug.enable([env.DEBUG, pattern].filter(Boolean).join(','))
}
export function logHttp (entry: HttpLogEntry): void {
  createDebug('sple:http')(`${entry.method} ${entry.path} ${entry.status} ${entry.durationMs}ms${entry.retries > 0 ? ` retry=${entry.retries}` : ''}`)
}
