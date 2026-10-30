/** Pure helpers behind the project page (tested without a DOM). */
import type { IssueSummary } from '../src/model'

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
