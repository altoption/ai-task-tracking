/** Bulk edit in list views: which rows are selected, and the one save_issues call an action becomes. */
import type { StatusDef } from '../src/model'

export type BulkPatch =
  | { state: string }
  | { priority: number }
  | { addLabels: string[] }
  | { removeLabels: string[] }
  | { project: string }

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

/** The selected ids still visible, in row order (a filter change can hide selected rows; actions skip those). */
export const visibleSelection = (selected: ReadonlySet<string>, ids: readonly string[]) => [...new Set(ids)].filter((id) => selected.has(id))

/** Closing statuses (Done, Canceled, Duplicate) ask for an optional reason, written as a comment on each issue. */
export const asksReason = (st: StatusDef | undefined) => !!st && (st.type === 'completed' || st.type === 'canceled' || st.type === 'duplicate')

/** The save_issues items for one action. */
export function bulkItems(ids: readonly string[], patch: BulkPatch, reason?: string): Record<string, unknown>[] {
  const comment = reason?.trim()
  return ids.map((id) => ({ id, ...patch, ...(comment ? { comment } : {}) }))
}
