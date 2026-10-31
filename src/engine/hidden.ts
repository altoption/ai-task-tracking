/**
 * Hidden projects (`hiddenProjects` in config.yml): the owner's view setting. What the UIs receive (the snapshot, the
 * event stream, Home, Needs you, search, the feed, the app's health poll) leaves hidden projects' issues out; the
 * HTTP server applies it on those UI endpoints only. MCP tools and `/api/tool/*` never look at it, and direct reads
 * (one issue, one project) still answer.
 */
import { isAbsolute, relative, sep } from 'node:path'
import type { Issue, LabelDef, Project } from '../model'
import type { FeedEvent } from './eventlog'
import { writerWorkspaces } from './queries'
import { NO_PROJECT, type Store } from './store'

/** The hidden slugs. A slug that names no project hides nothing. */
export function hiddenSlugs(s: Store): Set<string> {
  return new Set(s.config.hiddenProjects)
}

/** "Is this issue in a visible project?"; undefined when nothing is hidden, so callers can skip the work. */
export function visibleTest(s: Store): ((i: Pick<Issue, 'project'>) => boolean) | undefined {
  const hidden = hiddenSlugs(s)
  return hidden.size ? (i) => !hidden.has(i.project) : undefined
}

/** The hidden projects that exist, by name: the UI's labels for direct links, never its filter or group options. */
export function hiddenProjectsOut(s: Store): { slug: string; name: string }[] {
  return [...hiddenSlugs(s)].flatMap((slug) => {
    const p = s.projects.get(slug)
    if (slug === NO_PROJECT) return [{ slug, name: 'No project' }]
    return p ? [{ slug, name: p.name }] : []
  }).sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * What the UI may list, with hidden projects taken out: their issues, the projects themselves, labels that occur only
 * on hidden issues, and workspace mappings to a hidden project that no visible issue was written from. `hiddenIds`
 * lets the UI label a link to a hidden issue ("in a hidden project") instead of "not found".
 */
export function visibleParts(s: Store): {
  issues: Issue[]; projects: Project[]; labels: LabelDef[]; workspaces: Record<string, string>; hiddenIds: string[]
} {
  const hidden = hiddenSlugs(s)
  const all = s.all()
  if (!hidden.size) return { issues: all, projects: [...s.projects.values()], labels: s.labels, workspaces: s.config.workspaces, hiddenIds: [] }
  const issues: Issue[] = [], hiddenIds: string[] = []
  const shownLabels = new Set<string>(), hiddenLabels = new Set<string>(), shownWorkspaces = new Set<string>()
  for (const i of all) {
    if (hidden.has(i.project)) {
      hiddenIds.push(i.id)
      for (const l of i.labels) hiddenLabels.add(l)
      continue
    }
    issues.push(i)
    for (const l of i.labels) shownLabels.add(l)
    for (const w of writerWorkspaces(i)) shownWorkspaces.add(w)
  }
  return {
    issues,
    hiddenIds,
    projects: [...s.projects.values()].filter((p) => !hidden.has(p.slug)),
    labels: s.labels.filter((l) => shownLabels.has(l.name) || !hiddenLabels.has(l.name)),
    workspaces: Object.fromEntries(Object.entries(s.config.workspaces).filter(([w, slug]) => !hidden.has(slug) || shownWorkspaces.has(w))),
  }
}

/**
 * Feed entries the UI may see: by the issue's current project, else (a deleted issue) the project recorded on the
 * entry; an old entry of a deleted issue with no project recorded passes. Undefined when nothing is hidden.
 */
export function feedVisibleTest(s: Store): ((e: FeedEvent) => boolean) | undefined {
  const hidden = hiddenSlugs(s)
  if (!hidden.size) return undefined
  return (e) => {
    const p = s.get(e.id)?.project ?? e.project
    return !p || !hidden.has(p)
  }
}

/** Is this file (absolute, or relative to the data folder) inside a hidden project's folder? */
export function inHiddenFolder(s: Store, path: string): boolean {
  const hidden = hiddenSlugs(s)
  if (!hidden.size) return false
  const rel = isAbsolute(path) ? relative(s.root, path) : path
  const parts = rel.split(sep)
  return parts[0] === 'projects' && parts.length > 2 && hidden.has(parts[1]!)
}

/**
 * config.nextNumber without the keys only hidden projects use (a key a visible project shares stays); the same object
 * when nothing changes.
 */
export function visibleNextNumber(s: Store): Record<string, number> {
  const hidden = hiddenSlugs(s)
  const shown = new Set([...s.projects.values()].filter((p) => !hidden.has(p.slug)).map((p) => p.key))
  const keys = new Set([...hidden].flatMap((slug) => { const p = s.projects.get(slug); return p && !shown.has(p.key) ? [p.key] : [] }))
  if (!keys.size) return s.config.nextNumber
  return Object.fromEntries(Object.entries(s.config.nextNumber).filter(([k]) => !keys.has(k)))
}

/**
 * For the app's Settings list (`hiddenProjects` in /api/health): every project by name, then `_none` ("No project"),
 * and the hidden slugs as configured.
 */
export function hiddenHealth(s: Store): { selected: string[]; projects: { slug: string; name: string }[] } {
  const projects = [...s.projects.values()].filter((p) => p.slug !== NO_PROJECT).map((p) => ({ slug: p.slug, name: p.name }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return { selected: [...s.config.hiddenProjects], projects: [...projects, { slug: NO_PROJECT, name: 'No project' }] }
}
