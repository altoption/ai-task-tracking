import { describe, expect, test } from 'bun:test'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

/** Product code must not depend on one machine or one owner. */
const ROOT = join(import.meta.dir, '..')
const SCAN = ['src', 'ui', 'app/Sources', 'app/build.sh', 'scripts', 'skills', 'install.sh', 'uninstall.sh']
const SKIP_DIRS = new Set(['node_modules', 'dist', '.build'])
const FORBIDDEN: [RegExp, string][] = [
  [/\/Users\/[A-Za-z]/, 'absolute /Users path'],
  [/\/Volumes\//, 'absolute /Volumes path'],
  [/q-?pac/i, 'employer name'],
  // The product is AI Task Tracking; `Tracker` is only the Swift target's folder name (app/Sources/Tracker).
  [/(?<![-\w]|Sources\/)Tracker\b/, 'old product name (now AI Task Tracking)'],
]

async function files(p: string): Promise<string[]> {
  const st = await stat(p).catch(() => null)
  if (!st) return []
  if (st.isFile()) return [p]
  const out: string[] = []
  for (const e of await readdir(p, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue
    out.push(...(await files(join(p, e.name))))
  }
  return out
}

describe('portability', () => {
  test('no owner- or machine-specific strings in product code', async () => {
    const hits: string[] = []
    for (const target of SCAN) {
      for (const f of await files(join(ROOT, target))) {
        if (/\.(png|icns|ico|jpg)$/.test(f)) continue
        const lines = (await readFile(f, 'utf8')).split('\n')
        lines.forEach((line, i) => {
          for (const [re, why] of FORBIDDEN) if (re.test(line)) hits.push(`${relative(ROOT, f)}:${i + 1} ${why}: ${line.trim().slice(0, 100)}`)
        })
      }
    }
    expect(hits).toEqual([])
  })
})
