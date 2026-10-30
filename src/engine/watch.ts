import { watch, type FSWatcher } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { Store } from './store'

const DEBOUNCE_MS = 50

/** Paths the watcher never reports: VCS/app state dirs and editor/atomicWrite temp files. */
function ignored(rel: string): boolean {
  const parts = rel.split(sep)
  if (parts.includes('.git') || parts.includes('.tracker')) return true
  const name = parts[parts.length - 1]!
  // atomicWrite temp files are `.<name>.<hex>.tmp`, so the leading dot already covers them.
  return name.startsWith('.') || name.endsWith('~') || name.endsWith('.swp') || name.endsWith('.tmp')
    || (name.startsWith('#') && name.endsWith('#')) || name.startsWith('~$') // emacs autosave, Office lock file
}

/**
 * Feed external file changes into the Store. Debounces per path, skips the engine's own writes,
 * and rescans directories when a rename/unknown path means events may have been coalesced.
 */
export function watchFolder(store: Store): { close(): void } {
  const root = store.root
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let closed = false

  const isIssueFile = (full: string) => {
    const r = relative(root, full).split(sep)
    return r.length === 4 && r[0] === 'projects' && r[2] === 'issues' && r[3]!.endsWith('.md')
  }
  const reload = (path: string) => store.reloadFile(path).catch((e) => console.error('[watch] reload failed:', path, e))

  /** Reload every issue file under `dir` (meta files reload only on their own events), then any indexed issue that vanished from it. */
  async function rescan(dir: string): Promise<void> {
    const seen = new Set<string>()
    const walk = async (d: string) => {
      const entries = await readdir(d, { withFileTypes: true }).catch(() => [])
      for (const ent of entries) {
        const full = join(d, ent.name)
        if (ignored(relative(root, full))) continue
        if (ent.isDirectory()) await walk(full)
        else if (isIssueFile(full)) { seen.add(full); await reload(full) }
      }
    }
    await walk(dir)
    const prefix = dir + sep
    for (const issue of store.all()) {
      if (issue.path.startsWith(prefix) && !seen.has(issue.path)) await reload(issue.path)
    }
  }

  async function process(path: string, eventType: string): Promise<void> {
    if (closed) return
    const info = await stat(path).catch(() => null)
    if (info?.isDirectory()) return rescan(path)
    if (info) {
      if (!store.readsFile(path)) return reload(path) // not ours to write: no own-write check (and no reading big attachments)
      const text = await readFile(path, 'utf8').catch(() => null)
      if (text !== null && store.isOwnWrite(path, text)) return
      return reload(path)
    }
    // Gone. A tracked/known file name is a plain delete; otherwise it may be a removed
    // directory, or (on rename) a move whose other half we never saw: rescan the parent too.
    await reload(path)
    if (eventType === 'rename' || !/\.[a-z]+$/i.test(path)) await rescan(join(path, '..'))
  }

  let watcher: FSWatcher
  try {
    watcher = watch(root, { recursive: true }, (eventType, filename) => {
      if (closed || !filename) return
      const rel = filename.toString()
      if (ignored(rel)) return
      const path = join(root, rel)
      const prev = timers.get(path)
      if (prev) clearTimeout(prev)
      timers.set(path, setTimeout(() => {
        timers.delete(path)
        process(path, eventType).catch((e) => console.error('[watch] failed:', path, e))
      }, DEBOUNCE_MS))
    })
  } catch (e) {
    console.error('[watch] cannot watch', root, e)
    return { close() {} }
  }
  watcher.on('error', (e) => console.error('[watch] error:', e))

  return {
    close() {
      closed = true
      watcher.close()
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    },
  }
}
