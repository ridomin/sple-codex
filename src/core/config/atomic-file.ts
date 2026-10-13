import { randomUUID } from 'node:crypto'
import { open, rename, rm, link } from 'node:fs/promises'
import { dirname, join, basename } from 'node:path'

/** Temp files are user-only from creation, even when the caller's umask is permissive. */
export async function writeAtomic (path: string, contents: string, options: { overwrite?: boolean } = {}): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(contents, 'utf8'); await handle.sync() } finally { await handle.close() }
    if (options.overwrite === false) await link(temporary, path)
    else await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}
