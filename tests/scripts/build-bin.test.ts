import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildBin } from '../../scripts/build-bin'

/** scripts/build-bin.ts with every command stubbed: nothing is built or installed. */
const temps: string[] = []
afterAll(async () => { await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true }))) })

async function sandbox(docsBuild: 'ok' | 'fail', existingDocs = false) {
  const root = await mkdtemp(join(tmpdir(), 'aitt-build-bin-'))
  temps.push(root)
  const docs = join(root, 'site', 'dist', 'docs')
  if (existingDocs) { await mkdir(docs, { recursive: true }); await writeFile(join(docs, 'index.html'), 'old') }
  const calls: string[][] = [], logs: string[] = [], warns: string[] = []
  const run = async (cmd: string[]) => {
    calls.push(cmd)
    if (cmd.join(' ') === 'bun run docs:build') {
      if (docsBuild === 'fail') { await mkdir(docs, { recursive: true }); await writeFile(join(docs, 'half.html'), 'partial'); return 1 }
      await mkdir(docs, { recursive: true }); await writeFile(join(docs, 'index.html'), 'docs'); return 0
    }
    if (cmd[1] === 'build') { await mkdir(join(root, 'dist'), { recursive: true }); await writeFile(join(root, 'dist', 'aitt'), 'engine'); return 0 }
    return 99
  }
  return { root, docs, calls, logs, warns, opts: (withDocs: boolean) => ({ root, withDocs, run, log: (l: string) => logs.push(l), warn: (l: string) => warns.push(l) }) }
}

const assets = (cmd: string[]) => cmd.flatMap((a, i) => (cmd[i - 1] === '--asset' ? [a] : []))

describe('scripts/build-bin.ts', () => {
  test('bun run build: a failed docs build warns and still leaves an engine, without a partial site', async () => {
    const sb = await sandbox('fail', true)
    expect(await buildBin(sb.opts(true))).toBe(0)
    expect(sb.warns.join('\n')).toContain('docs not built: bun run docs:build exited with 1')
    expect((await stat(join(sb.root, 'dist', 'aitt'))).isFile()).toBe(true)
    expect(await stat(sb.docs).catch(() => null)).toBeNull() // neither the partial build nor the older one is embedded
    expect(assets(sb.calls.at(-1)!)).toEqual(['ui/dist'])
    expect(sb.logs.join('\n')).toContain('no docs embedded')
  })

  test('bun run build: the docs are built first and embedded', async () => {
    const sb = await sandbox('ok')
    expect(await buildBin(sb.opts(true))).toBe(0)
    expect(sb.calls.map((c) => c.slice(0, 3).join(' '))).toEqual(['bun run docs:build', 'bun build --compile'])
    expect(assets(sb.calls.at(-1)!)).toEqual(['ui/dist', 'site/dist/docs'])
    expect(sb.warns).toEqual([])
  })

  test('bun run build:bin: embeds an existing docs build and says when it was built; never builds the docs', async () => {
    const sb = await sandbox('fail', true)
    expect(await buildBin(sb.opts(false))).toBe(0)
    expect(sb.calls).toHaveLength(1)
    expect(assets(sb.calls[0]!)).toEqual(['ui/dist', 'site/dist/docs'])
    expect(sb.logs.join('\n')).toMatch(/embedding the docs from site\/dist\/docs \(built \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\)/)
  })

  test('bun run build:bin without a docs build: the engine alone, and a note saying so', async () => {
    const sb = await sandbox('ok')
    expect(await buildBin(sb.opts(false))).toBe(0)
    expect(assets(sb.calls[0]!)).toEqual(['ui/dist'])
    expect(sb.logs.join('\n')).toContain('no docs embedded')
  })
})
