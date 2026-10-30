import { randomBytes } from 'node:crypto'
import { link, lstat, open, readdir, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** Exact name of an atomicWrite temp file: `.<name>.<12 lowercase hex>.tmp`. */
export const TEMP_NAME = /^\..+\.[0-9a-f]{12}\.tmp$/
/** .gitignore line that keeps temp files (atomicWrite's and editors' dot-temp files) out of git. */
export const TEMP_IGNORE = '.*.tmp'
/** Editor/Office scratch files the watcher also ignores: emacs autosaves `#x#` (escaped: `#` starts a comment) and Office locks `~$x`. */
export const EDITOR_IGNORES = ['\\#*#', '~$*']
/** Every line the data folder's .gitignore must have (besides `.tracker/`). */
export const GITIGNORE_LINES = [TEMP_IGNORE, ...EDITOR_IGNORES]

/**
 * Remove atomicWrite temp files left in `dir` by a crash (kill -9 between write and rename).
 * Only regular files whose name matches TEMP_NAME exactly and that are older than `minAgeMs`
 * (so another process's in-flight write is never touched). Returns the removed paths.
 */
export async function removeStaleTemps(dir: string, minAgeMs: number): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  const removed: string[] = []
  for (const name of names) {
    if (!TEMP_NAME.test(name)) continue
    const p = join(dir, name)
    const st = await lstat(p).catch(() => null)
    if (!st?.isFile() || Date.now() - st.mtimeMs < minAgeMs) continue
    await unlink(p).then(() => removed.push(p), () => {})
  }
  return removed
}

const tempFor = (path: string) => join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`)

async function writeTemp(tmp: string, data: string, mode?: number): Promise<void> {
  // With a mode, the temp file is created with it (the umask can only narrow it) and then set exactly,
  // so the file never exists with wider permissions than asked for.
  const fh = await open(tmp, 'wx', mode ?? 0o666)
  try {
    if (mode !== undefined) await fh.chmod(mode)
    await fh.writeFile(data, 'utf8')
    await fh.sync()
  } finally {
    await fh.close()
  }
}

/** Write `data` to `path` atomically: temp file in the same dir, fsync, rename. `mode`: the file's permissions (default: umask). */
export async function atomicWrite(path: string, data: string, mode?: number): Promise<void> {
  const tmp = tempFor(path)
  try {
    await writeTemp(tmp, data, mode)
    await rename(tmp, path)
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  }
}

/**
 * Create `path` with `data` atomically and exclusively: temp file, fsync, hard-link into place.
 * Fails with code EEXIST (leaving the existing file untouched) if `path` already exists.
 */
export async function atomicCreate(path: string, data: string): Promise<void> {
  const tmp = tempFor(path)
  try {
    await writeTemp(tmp, data)
    await link(tmp, path)
  } finally {
    await unlink(tmp).catch(() => {})
  }
}
