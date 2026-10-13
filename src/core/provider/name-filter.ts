import { UsageError } from './errors.js'

/** Literal substring by default; /pattern/flags opts into an explicit regular expression. */
export function nameFilter (value: string | undefined): (name: string) => boolean {
  if (value === undefined) return () => true
  if (!value.startsWith('/')) return name => name.toLowerCase().includes(value.toLowerCase())
  const end = value.lastIndexOf('/')
  if (end === 0) throw new UsageError('Regex filters use /pattern/flags')
  const flags = value.slice(end + 1)
  if (!/^[imsu]*$/.test(flags)) throw new UsageError('Regex filter flags may be i, m, s or u')
  let regex: RegExp
  try { regex = new RegExp(value.slice(1, end), flags) } catch { throw new UsageError('Invalid playlist filter regular expression') }
  return name => regex.test(name)
}
