import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ActivityEntry, Issue, Priority, Project } from '../model'
import { serializeIssue } from '../store/issueFile'
import { DEFAULT_STATUSES, initFolder, readConfig, writeConfig, writeProject } from '../store/metaFiles'

const WORDS = (
  'fan curve quote damper coil airflow pressure static motor drive panel filter casing sensor controller ' +
  'customer order warranty registration wizard sync drift report export import parser table schema api ' +
  'endpoint token cache queue retry timeout latency index search migration deploy build release branch ' +
  'review merge test fixture regression crash memory leak null pointer config setting toggle feature ' +
  'support ticket escalation priority backlog sprint estimate dashboard metric chart pdf document upload'
).split(' ')
const LABELS = ['Bug', 'Feature', 'Improvement', 'Task', 'Needs decision', 'Blocked']
const STATUS_WEIGHTS: [string, number][] = [['Backlog', 30], ['Todo', 25], ['In Progress', 10], ['Waiting', 5], ['Done', 25], ['Canceled', 5]]
const PROJECTS = ['alpha', 'bravo', 'charlie', 'delta']
const KEY = 'S'

/** Deterministic PRNG (mulberry32) so benches are reproducible. */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Write a synthetic tracker folder with `n` issues (ids S-1..S-n) into `root`:
 * random parent trees (depth <= 5), ~20% with blockers (always earlier ids), ~1.5 kB descriptions,
 * some comments. Used by the perf test and `aitt bench`.
 */
export async function generateSynthetic(root: string, n: number): Promise<void> {
  const r = rng(42)
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!
  const sentence = (words: number) => Array.from({ length: words }, () => pick(WORDS)).join(' ')
  const paragraph = (bytes: number) => {
    let s = ''
    while (s.length < bytes) s += sentence(8 + Math.floor(r() * 8)) + '. '
    return s.trim()
  }
  const status = () => {
    let x = r() * 100
    for (const [name, w] of STATUS_WEIGHTS) if ((x -= w) < 0) return name
    return 'Backlog'
  }

  await initFolder(root)
  for (const slug of PROJECTS) {
    const p: Project = { slug, name: slug[0]!.toUpperCase() + slug.slice(1), key: KEY, status: 'Active', repos: [slug], milestones: [], description: `Synthetic project ${slug}.`, docs: [] }
    await writeProject(join(root, 'projects', slug), p)
  }
  const config = await readConfig(root)
  config.statuses = DEFAULT_STATUSES.map((s) => ({ ...s }))
  config.nextNumber = { ...config.nextNumber, [KEY]: n + 1 }
  await writeConfig(root, config)

  const depth = new Uint8Array(n + 1)
  const projectOf: string[] = []
  const issues: Issue[] = []
  const base = Date.parse('2026-01-01T00:00:00Z')
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
  for (let k = 1; k <= n; k++) {
    let parent: string | null = null
    let project = pick(PROJECTS)
    depth[k] = 1
    if (k > 1 && r() < 0.6) {
      const p = Math.max(1, k - 1 - Math.floor(r() * 200))
      if (depth[p]! < 5) { parent = `${KEY}-${p}`; depth[k] = depth[p]! + 1; project = projectOf[p]! }
    }
    projectOf[k] = project
    const blockedBy: string[] = []
    if (k > 3 && r() < 0.2) {
      const m = 1 + Math.floor(r() * 2)
      for (let b = 0; b < m; b++) {
        const id = `${KEY}-${1 + Math.floor(r() * (k - 1))}`
        if (!blockedBy.includes(id)) blockedBy.push(id)
      }
    }
    const created = base + k * 60_000
    const activity: ActivityEntry[] = []
    if (r() < 0.3) {
      for (let c = 0, m = 1 + Math.floor(r() * 2); c < m; c++) {
        activity.push({ at: iso(created + (c + 1) * 3_600_000), actor: 'agent', workspace: pick(PROJECTS), branch: 'main', body: paragraph(160) })
      }
    }
    const labels = [pick(LABELS)]
    issues.push({
      id: `${KEY}-${k}`, title: sentence(4 + Math.floor(r() * 5)), status: status(), priority: Math.floor(r() * 5) as Priority,
      labels, parent, blockedBy, related: [], milestone: null, due: null, plan: null, links: [],
      created: iso(created), updated: iso(created + 7_200_000),
      touchedBy: { actor: 'agent', workspace: pick(PROJECTS) }, extra: {},
      description: paragraph(1500), activity, project, path: join(root, 'projects', project, 'issues', `${KEY}-${k}.md`),
    })
  }
  for (const slug of PROJECTS) await mkdir(join(root, 'projects', slug, 'issues'), { recursive: true })
  const BATCH = 256
  for (let i = 0; i < issues.length; i += BATCH) {
    await Promise.all(issues.slice(i, i + BATCH).map((iss) => writeFile(iss.path, serializeIssue(iss), 'utf8')))
  }
}
