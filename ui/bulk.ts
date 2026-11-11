/** Bulk edit in list views: which rows are selected, and the one save_issues call an action becomes. */
import type { StatusDef } from '../src/model'

export type BulkPatch =
  | { state: string }
  | { priority: number }
  | { addLabels: string[] }
  | { removeLabels: string[] }
  | { project: string }
  | { parentId: string | null }
  | { milestone: string | null }

/**
 * The selection after a click on row `id` (at `index` among `ids`, the visible rows in order).
 * A plain click toggles the row; a shift-click sets every row from the last clicked one (`anchor`) to this one to the
 * clicked row's new state.
 */
export function clickSelect(selected: ReadonlySet<string>, ids: readonly string[], index: number, anchor: number | null, shift: boolean): Set<string> {
  const id = ids[index]
  const next = new Set(selected)
  if (id === undefined) return next
  const on = !selected.has(id)
  const [from, to] = shift && anchor !== null && anchor < ids.length ? [Math.min(anchor, index), Math.max(anchor, index)] : [index, index]
  for (let k = from; k <= to; k++) { const r = ids[k]!; if (on) next.add(r); else next.delete(r) }
  return next
}

/**
 * Each listed issue's sub-issues, at any depth, among the issues listed (`ids`: every row of the view, whatever group
 * it is in, so an epic in one status takes its steps in the others). Issues without any are left out. Cycle-safe.
 */
export function families(ids: readonly string[], parentOf: (id: string) => string | null | undefined): Map<string, string[]> {
  const listed = new Set(ids)
  const out = new Map<string, string[]>()
  for (const id of listed) {
    const seen = new Set([id])
    for (let p = parentOf(id); p && !seen.has(p); p = parentOf(p)) {
      seen.add(p)
      if (!listed.has(p)) continue
      const l = out.get(p)
      if (l) l.push(id); else out.set(p, [id])
    }
  }
  return out
}

/** The sub-issues (at any depth) of selected rows that aren't selected themselves: what "Add sub-issues" would add. */
export function missingKids(selected: ReadonlySet<string>, family: ReadonlyMap<string, readonly string[]>): string[] {
  const out = new Set<string>()
  for (const id of selected) for (const k of family.get(id) ?? []) if (!selected.has(k)) out.add(k)
  return [...out]
}

/** The selection after taking (`on`) or dropping every id in `ids`. */
export function setMany(selected: ReadonlySet<string>, ids: readonly string[], on: boolean): Set<string> {
  const next = new Set(selected)
  for (const id of ids) { if (on) next.add(id); else next.delete(id) }
  return next
}

/** The selected ids still visible, in row order (a filter change can hide selected rows; actions skip those). */
export const visibleSelection = (selected: ReadonlySet<string>, ids: readonly string[]) => [...new Set(ids)].filter((id) => selected.has(id))

/** Closing statuses (Done, Canceled, Duplicate) ask for an optional reason, written as a comment on each issue. */
export const asksReason = (st: StatusDef | undefined) => !!st && (st.type === 'completed' || st.type === 'canceled' || st.type === 'duplicate')

/** The save_issues items for one action. */
export function bulkItems(ids: readonly string[], patch: BulkPatch, reason?: string): Record<string, unknown>[] {
  const comment = reason?.trim()
  return ids.map((id) => ({ id, ...patch, ...(comment ? { comment } : {}) }))
}

/** What a key does in a list: move the cursor row, select it (`family`: with its sub-issues), or open it. */
export type ListKey = 'down' | 'up' | 'extendDown' | 'extendUp' | 'toggle' | 'family' | 'open'
export function listKey(key: string, shift: boolean): ListKey | null {
  if (key === 'ArrowDown' || key === 'j' || key === 'J') return shift ? 'extendDown' : 'down'
  if (key === 'ArrowUp' || key === 'k' || key === 'K') return shift ? 'extendUp' : 'up'
  if (key === 'x' || key === ' ') return 'toggle'
  if (key === 'X') return 'family'
  if (key === 'Enter' || key === 'o') return 'open'
  return null
}

/** The one project every selected issue is in (milestones belong to a project), or null when they differ. */
export function commonProject(ids: readonly string[], projectOf: (id: string) => string | undefined): string | null {
  let p: string | undefined
  for (const id of ids) {
    const x = projectOf(id)
    if (x === undefined || (p !== undefined && x !== p)) return null
    p = x
  }
  return p ?? null
}
