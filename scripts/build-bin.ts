#!/usr/bin/env bun
/**
 * Compiles the engine (dist/aitt) with the UI and, when it has been built, the docs site embedded.
 *
 *   bun scripts/build-bin.ts               (bun run build:bin) embed site/dist/docs if present, and say which
 *   bun scripts/build-bin.ts --with-docs   (bun run build) build the docs first; if that fails, warn and build
 *                                          the engine without them, so an install never fails over the docs
 *
 * The engine serves /docs/ from the embedded copy; without one, /docs/ answers with how to build them.
 */
import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface BuildOpts {
  root: string
  withDocs: boolean
  /** Runs a command in `root` with inherited output; resolves to its exit code. */
  run: (cmd: string[]) => Promise<number>
  log: (line: string) => void
  warn: (line: string) => void
}

const stamp = (d: Date) => d.toLocaleString('sv-SE') // 2026-10-29 07:41:54, local time

export async function buildBin(o: BuildOpts): Promise<number> {
  const docs = join(o.root, 'site', 'dist', 'docs')
  if (o.withDocs) {
    const code = await o.run(['bun', 'run', 'docs:build'])
    if (code !== 0) {
      o.warn(`! docs not built: bun run docs:build exited with ${code}; building the engine without them`)
      await rm(docs, { recursive: true, force: true }) // never embed a partial or older site
    }
  }
  const built = await stat(join(docs, 'index.html')).catch(() => null)
  o.log(built
    ? `• embedding the docs from site/dist/docs (built ${stamp(built.mtime)})`
    : '• no docs embedded: site/dist/docs has no build (bun run docs:build); /docs/ will say so')
  return o.run(['bun', 'build', '--compile', 'src/cli.ts', '--asset', 'ui/dist', ...(built ? ['--asset', 'site/dist/docs'] : []), '--outfile', 'dist/aitt'])
}

if (import.meta.main) {
  const root = join(import.meta.dir, '..')
  process.exit(await buildBin({
    root,
    withDocs: process.argv.includes('--with-docs'),
    run: (cmd) => Bun.spawn(cmd, { cwd: root, stdout: 'inherit', stderr: 'inherit' }).exited,
    log: (l) => console.log(l),
    warn: (l) => console.error(l),
  }))
}
