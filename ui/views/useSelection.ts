/**
 * The selection behind bulk edit, shared by the list and the board: which of the rows (or cards) on screen are
 * selected, click and shift-click, ⌘A for all of them, Esc to clear, and the sub-issues a selected parent could
 * take with it. Only ids in `ids` (what is on screen, in order) ever count.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clickSelect, families, missingKids, setMany, visibleSelection } from '../bulk'

export function useSelection(ids: readonly string[], familyIds: readonly string[], parentOf: (id: string) => string | null | undefined) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const anchor = useRef<number | null>(null)
  const picked = useMemo(() => visibleSelection(selected, ids), [selected, ids])
  // Sub-issues anywhere in the view, ones folded away included (taking them shows them).
  const family = useMemo(() => families(familyIds, parentOf), [familyIds, parentOf])
  const kidsToAdd = useMemo(() => missingKids(new Set(picked), family), [picked, family])
  const clear = useCallback(() => { setSelected(new Set()); anchor.current = null }, [])
  /** A click on the box of the row at `index`: toggle it, or with shift everything from the last clicked row to it. */
  const click = useCallback((index: number, shift: boolean) => {
    const from = anchor.current // read now: the updater runs later, after the anchor moves
    setSelected((s) => clickSelect(s, ids, index, from, shift))
    anchor.current = index
  }, [ids])
  const set = useCallback((list: readonly string[], on: boolean) => setSelected((s) => setMany(s, list, on)), [])
  /** The row and every sub-issue under it, taken or dropped together. True when they were taken. */
  const toggleFamily = useCallback((id: string): boolean => {
    const all = [id, ...(family.get(id) ?? [])]
    const on = all.some((x) => !selected.has(x))
    set(all, on)
    return on
  }, [family, selected, set])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest('input:not([type="checkbox"]), textarea, select, [contenteditable="true"], [role="dialog"]')) return
      if (document.querySelector('.overlay')) return // a dialog or the palette owns the keyboard
      if (e.key === 'Escape' && picked.length) clear()
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && ids.length) { e.preventDefault(); setSelected(new Set(ids)) }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [picked.length, ids, clear])
  return { selected, picked, family, kidsToAdd, anchor, click, set, toggleFamily, clear }
}
