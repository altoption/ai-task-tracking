import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { feedPath } from '../../src/engine/eventlog'
import { filterIssues, home, needsYouCount, search } from '../../src/engine/queries'
import { Store } from '../../src/engine/store'
import { generateSynthetic } from '../../src/engine/synthetic'

// Runs by default; set SKIP_PERF=1 to skip. Each budget is the median of 3 runs.
const perf = process.env.SKIP_PERF === '1' ? test.skip : test
const N = 10_000

async function median3(fn: () => unknown | Promise<unknown>): Promise<number> {
  const t: number[] = []
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now()
    await fn()
    t.push(performance.now() - t0)
  }
  return t.sort((a, b) => a - b)[1]!
}

describe('perf (10k issues)', () => {
  perf('open < 1000 ms; home, search, filter, needs-you count < 50 ms (with a 30k-event feed log for the stalled rules)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tracker-perf-'))
    await generateSynthetic(root, N)
    // Three status moves per issue in the last days, by agent sessions: the history the stalled rules read.
    const now = Date.now()
    const lines: string[] = []
    for (let k = 1; k <= N; k++) {
      for (const [n, from, to] of [[3, 'Todo', 'In Progress'], [2, 'In Progress', 'Waiting'], [1, 'Waiting', 'In Progress']] as const) {
        lines.push(JSON.stringify({ at: new Date(now - n * 3_600_000 - k).toISOString(), id: `S-${k}`, kind: 'status', from, to,
          actor: { actor: 'agent', workspace: 'alpha', session: `s${k % 50}` } }))
      }
    }
    await mkdir(join(root, '.tracker'), { recursive: true })
    await writeFile(feedPath(root), lines.join('\n') + '\n')

    // generator shape sanity
    let files = 0
    for (const p of await readdir(join(root, 'projects'))) files += (await readdir(join(root, 'projects', p, 'issues'))).length
    expect(files).toBe(N)

    let s!: Store
    const open = await median3(async () => { s = await Store.open(root) })
    expect(s.all()).toHaveLength(N)
    expect(s.errors.size).toBe(0)
    const all = s.all()
    expect(all.filter((i) => i.blockedBy.length).length / N).toBeGreaterThan(0.15)
    expect(all.reduce((n, i) => n + i.description.length, 0) / N).toBeGreaterThan(1400)

    let h!: ReturnType<typeof home>
    const tHome = await median3(() => { h = home(s) })
    const tSearch = await median3(() => search(s, 'quote'))
    const tFilter = await median3(() => filterIssues(s, { labels: ['Bug'], priority: [1, 2], status: ['Todo', 'In Progress', 'Backlog'] }))
    const tCount = await median3(() => needsYouCount(s))
    expect(s.history('S-1')).toHaveLength(3)
    expect(h.readyNext.length).toBeGreaterThan(0)
    expect(search(s, 'quote').length).toBeGreaterThan(0)

    console.log(`perf n=${N}: open ${open.toFixed(0)} ms, home ${tHome.toFixed(1)} ms, search ${tSearch.toFixed(1)} ms, filter ${tFilter.toFixed(1)} ms, needs-you count ${tCount.toFixed(1)} ms`)
    expect(open).toBeLessThan(1000)
    expect(tHome).toBeLessThan(50)
    expect(tSearch).toBeLessThan(50)
    expect(tFilter).toBeLessThan(50)
    expect(tCount).toBeLessThan(50)
  }, 120_000)
})
