/** Pure helpers behind the project page (tested without a DOM). */
import type { IssueSummary } from '../src/model'
import type { Route } from './router'

export interface Progress { done: number; total: number }

/** Done/total of the project's issues per milestone name (every listed milestone present, zeros included). `closed` says which statuses count as done. */
export function milestoneProgress(issues: Iterable<IssueSummary>, project: string, milestones: string[], closed: (status: string) => boolean): Map<string, Progress> {
  const out = new Map<string, Progress>(milestones.map((m) => [m, { done: 0, total: 0 }]))
  for (const i of issues) {
    if (i.project !== project || !i.milestone) continue
    const p = out.get(i.milestone)
    if (!p) continue
    p.total++
    if (closed(i.status)) p.done++
  }
  return out
}

/** A milestone's target date for display; non-ISO text is shown as written. */
export function targetLabel(target: string | undefined): string {
  if (!target) return ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) return target
  const d = new Date(`${target}T12:00:00`)
  return Number.isNaN(d.getTime()) ? target : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/** The first line of a markdown description as plain text, for the one-line summary (empty when there is none). */
export function firstLine(markdown: string): string {
  for (const raw of markdown.split('\n')) {
    const line = raw.replace(/^\s*(#{1,6}|[-*+]|\d+\.|>)\s+/, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').trim()
    if (line) return line
  }
  return ''
}

/** A milestone's target without the year when it is this year ("Mar 27"); non-ISO text as written. */
export function shortTarget(target: string | undefined, now = new Date()): string {
  if (!target) return ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) return target
  const d = new Date(`${target}T12:00:00`)
  if (Number.isNaN(d.getTime())) return target
  return d.toLocaleDateString('en-US', d.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' })
}

/**
 * The ordering after a milestone chip is picked or cleared. A milestone is a set of steps, so picking one lists it by
 * dependencies and clearing it goes back to the page's usual order; an ordering the viewer chose is left alone.
 */
export function milestoneOrder(orderBy: string, usual: string, picking: boolean): string {
  const [from, to] = picking ? [usual, 'dependency'] : ['dependency', usual]
  return orderBy === from ? to : orderBy
}

// ---------- views that belong to a project ----------

interface OwnedView { slug: string; name: string; project?: string; favorite?: boolean }

/** A project's own views, by name. */
export function projectViews<V extends OwnedView>(views: readonly V[], project: string): V[] {
  return views.filter((v) => v.project === project).sort((a, b) => a.name.localeCompare(b.name))
}

/** Where a view opens: inside its project's page, or on its own when it is system-wide or its project is gone. */
export function viewRoute(v: OwnedView, hasProject: (slug: string) => boolean): Route {
  return v.project && hasProject(v.project) ? { name: 'project', slug: v.project, view: v.slug } : { name: 'view', slug: v.slug }
}

/** The sidebar's views: the system-wide ones, a project's view only when starred, and any view whose project is gone. Starred first, then by name. */
export function sidebarViews<V extends OwnedView>(views: readonly V[], hasProject: (slug: string) => boolean): V[] {
  return views.filter((v) => !v.project || !hasProject(v.project) || v.favorite)
    .sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || a.name.localeCompare(b.name))
}
