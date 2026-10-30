import { realpathSync, statSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'

/** Where the server reads the built UI from: `ui/dist` on disk (dev) or the files embedded in the compiled binary. */
export interface UiSource {
  kind: 'disk' | 'embedded'
  /** `name` is a URL path without the leading slash (`index.html`, `index-abc.js`); undefined when absent. */
  get(name: string): Blob | undefined
}

type Named = readonly (readonly [string, Blob])[]
const named = (files: ReadonlyArray<Blob>): Named =>
  files.map((f) => [((f as Blob & { name?: string }).name ?? '').replace(/^\.\//, ''), f] as const)

const isIndex = (n: string) => n === 'index.html' || n.endsWith('/index.html')
const isDocsIndex = (n: string) => n === 'docs/index.html' || n.endsWith('/docs/index.html')
/** The folder of the shallowest name that passes `test` (with its trailing slash), if any. */
function shallowestRoot(all: Named, test: (n: string) => boolean): string | undefined {
  return all.map(([n]) => n).filter(test).sort((a, b) => a.length - b.length)[0]?.slice(0, -'index.html'.length)
}
/** Files under `root`, keyed by the rest of their name. */
function under(all: Named, root: string | undefined): Map<string, Blob> {
  const m = new Map<string, Blob>()
  if (root !== undefined) for (const [n, f] of all) if (n.startsWith(root) && n.length > root.length) m.set(n.slice(root.length), f)
  return m
}

/**
 * Bun.embeddedFiles from `bun build --compile --asset ui/dist --asset site/dist/docs` are Blobs named by a
 * build-relative path whose prefix depends on Bun's bundle root (`dist/index-abc.js` today, `ui/dist/…` from other
 * roots). The docs site (`docs/…`) is set aside first; the UI root is then the directory of the shallowest
 * `index.html`. Keep only files under it, keyed by the name the browser requests.
 */
export function uiAssetMap(files: ReadonlyArray<Blob>): Map<string, Blob> {
  const all = named(files)
  const docs = shallowestRoot(all, isDocsIndex)
  const rest = docs === undefined ? all : all.filter(([n]) => !n.startsWith(docs))
  return under(rest, shallowestRoot(rest, isIndex))
}

/** The embedded docs site, keyed by its path under /docs/ (`index.html`, `start/install/index.html`, `pagefind/…`). */
export function docsAssetMap(files: ReadonlyArray<Blob>): Map<string, Blob> {
  const all = named(files)
  return under(all, shallowestRoot(all, isDocsIndex))
}

/** The embedded docs, or undefined when the binary was built without them. */
export function embeddedDocs(files: ReadonlyArray<Blob>): UiSource | undefined {
  const m = docsAssetMap(files)
  if (!m.has('index.html')) return undefined
  return { kind: 'embedded', get: (name) => m.get(name) }
}

/** The embedded UI, or undefined when the files carry no index.html (not a compiled binary, or built without the UI). */
export function embeddedUi(files: ReadonlyArray<Blob>): UiSource | undefined {
  const m = uiAssetMap(files)
  if (!m.has('index.html')) return undefined
  return { kind: 'embedded', get: (name) => m.get(name) }
}

/**
 * A built site on disk (`ui/dist`, `site/dist/docs`). A name that normalizes outside the directory, or whose real
 * path (symlinks resolved) is outside it, is never served; the file is read at its real path.
 */
export function diskUi(dir: string): UiSource {
  return {
    kind: 'disk',
    get(name) {
      const full = join(dir, normalize(name))
      if (!full.startsWith(dir + sep)) return undefined
      try {
        const real = realpathSync(full)
        if (!real.startsWith(realpathSync(dir) + sep) || !statSync(real).isFile()) return undefined
        return Bun.file(real)
      } catch {
        return undefined // missing, or a dangling link
      }
    },
  }
}

/** Compiled binary → embedded files (if it has them); otherwise the given ui/dist directory. */
export function defaultUi(dir: string): UiSource {
  return (Bun.isStandaloneExecutable ? embeddedUi(Bun.embeddedFiles) : undefined) ?? diskUi(dir)
}

/** Compiled binary → its embedded docs (if it has them); otherwise the given site/dist/docs directory. */
export function defaultDocs(dir: string): UiSource {
  return (Bun.isStandaloneExecutable ? embeddedDocs(Bun.embeddedFiles) : undefined) ?? diskUi(dir)
}
