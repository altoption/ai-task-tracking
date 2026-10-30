/** Rewriting a user's file never widens its permissions (configs and notes can hold secrets). */
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, readFile, stat, writeFile } from 'node:fs/promises'

/** The permission bits of `path` (of a symlink's target), or undefined when it doesn't exist. */
export const fileMode = (path: string): Promise<number | undefined> => stat(path).then((s) => s.mode & 0o777, () => undefined)

/** Copy `src` to a new file `bak` with `mode` (created with it, then set exactly; never wider in between). */
export async function backupFile(src: string, bak: string, mode: number): Promise<void> {
  await writeFile(bak, await readFile(src), { flag: 'wx', mode })
  await chmod(bak, mode)
}

/** A new backup name next to `path`: `<path>.bak-aitt-<UTC stamp>`, with a random suffix if that is taken. */
export function backupName(path: string): string {
  const bak = `${path}.bak-aitt-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`
  return existsSync(bak) ? `${bak}-${randomBytes(3).toString('hex')}` : bak
}
