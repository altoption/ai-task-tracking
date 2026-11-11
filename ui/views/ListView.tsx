/**
 * The list: collapsible groups, rows virtualized with @tanstack/react-virtual so 10k issues
 * scroll smoothly. Sub-issues form a tree under their parent (guide lines, a chevron to fold a parent away); a
 * sub-issue whose parent is in another group names it in a crumb after the title instead of repeating the parent row.
 * Rows can be selected (checkbox, shift-click for a range, ⌥-click for a row with its sub-issues, a group's box for
 * the group, ⌘A, Esc clears; from the keyboard ↑ ↓ or j k, x, Shift+X, Enter) and changed together in the bulk bar, which floats over the foot of the list.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Config, IssueSummary, ViewDisplay } from '../../src/model'
import { ConceptIcon, PriorityIcon, ProgressPill, StatusIcon, Icon } from '../components/icons'
import { href, navigate } from '../router'
import { listRows, type ListRow, type ViewGroup } from '../viewModel'
import { PropertyCells, type CellCtx } from './IssueCells'
import { BulkBar } from './BulkBar'
import { listKey } from '../bulk'
import { useSelection } from './useSelection'

type Item = { kind: 'group'; group: ViewGroup; collapsed: boolean } | ({ kind: 'row' } & ListRow)
const ROW = 40

export function GroupIcon({ by, group, config }: { by: string; group: { key: string }; config: Config | null }) {
  if (by === 'status') return <StatusIcon status={group.key} config={config} />
  if (by === 'priority') return <PriorityIcon priority={Number(group.key)} />
  if (by === 'project') return <ConceptIcon concept="project" />
  if (by === 'parent') return <ConceptIcon concept="parent" />
  if (by.startsWith('label-group:')) return <ConceptIcon concept="labels" />
  return null
}

export function ListView({ groups, display, byId, config, cells }: {
  groups: ViewGroup[]
  display: ViewDisplay
  byId: ReadonlyMap<string, IssueSummary>
  config: Config | null
  cells: CellCtx
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const scroller = useRef<HTMLDivElement>(null)
  const grouped = display.groupBy !== 'none'
  const [folded, setFolded] = useState<Set<string>>(() => new Set())
  const fold = (id: string) => setFolded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  // `items`: what is drawn. `groupIds`: each group's drawn rows. `family`: each row's sub-issues anywhere in the
  // view (an epic's steps sit in other status groups), folded-away ones included: taking them unfolds them, because a
  // bulk change only ever touches rows on screen.
  const { items, groupIds, allIds } = useMemo(() => {
    const out: Item[] = []
    const groupIds = new Map<string, string[]>()
    const allIds: string[] = []
    for (const g of groups) {
      const isCollapsed = collapsed.has(g.key)
      if (grouped) out.push({ kind: 'group', group: g, collapsed: isCollapsed })
      if (isCollapsed) continue
      const full = listRows(g.issues, byId, display.showSubIssues)
      allIds.push(...full.map((r) => r.issue.id))
      const drawn = folded.size ? listRows(g.issues, byId, display.showSubIssues, folded) : full
      groupIds.set(g.key, drawn.map((r) => r.issue.id))
      for (const r of drawn) out.push({ kind: 'row', ...r })
    }
    return { items: out, groupIds, allIds }
  }, [groups, collapsed, folded, byId, display.showSubIssues, grouped])
  const v = useVirtualizer({ count: items.length, getScrollElement: () => scroller.current, estimateSize: () => ROW, overscan: 12 })
  const props = useMemo(() => new Set(display.properties), [display.properties])
  // A slot for the fold chevron only when some row has sub-issues here, so flat lists keep their left edge.
  const tree = useMemo(() => items.some((it) => it.kind === 'row' && it.kids > 0), [items])
  const toggle = (key: string) => setCollapsed((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n })

  // Selection: ids of the visible rows in order (group headers skipped). Only rows on screen count: a selected row
  // that a fold or a filter hides is left alone, and the count says so.
  const rowIds = useMemo(() => items.flatMap((it) => (it.kind === 'row' ? [it.issue.id] : [])), [items])
  const parentOf = useCallback((id: string) => byId.get(id)?.parent, [byId])
  const sel = useSelection(rowIds, allIds, parentOf)
  const { selected, picked, kidsToAdd, clear } = sel
  /** Open these parents, so the sub-issues just selected under them are on screen. */
  const unfold = (ids: string[]) => setFolded((f) => { const n = new Set(f); for (const x of ids) n.delete(x); return n.size === f.size ? f : n })
  /** The row with every sub-issue under it, taken or dropped together (⌥-click, Shift+X). Folded ones are shown. */
  const takeFamily = (id: string) => { if (sel.toggleFamily(id)) unfold([id, ...(sel.family.get(id) ?? [])]) }
  const check = (rowIndex: number, shift: boolean, alt: boolean) => {
    const id = rowIds[rowIndex]!
    if (alt && sel.family.has(id)) { takeFamily(id); sel.anchor.current = rowIndex } else sel.click(rowIndex, shift)
  }
  const addKids = () => { sel.set(kidsToAdd, true); unfold([...picked, ...kidsToAdd]) }

  let rowIndex = -1
  const rowIndexAt = new Map<number, number>()
  const itemOfRow: number[] = []
  items.forEach((it, k) => { if (it.kind === 'row') { rowIndexAt.set(k, ++rowIndex); itemOfRow.push(k) } })

  // The keyboard: a cursor row moved with ↑ ↓ (or j k; with shift, selecting as it goes), x or space to select it,
  // Shift+X with its sub-issues, Enter or o to open it. The cursor follows the issue, not the position.
  const [cursorId, setCursorId] = useState<string | null>(null)
  const cursor = cursorId === null ? -1 : rowIds.indexOf(cursorId)
  const keys = useRef({ cursor, rowIds, itemOfRow, check, takeFamily, sel })
  keys.current = { cursor, rowIds, itemOfRow, check, takeFamily, sel }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      if (t?.closest('input:not([type="checkbox"]), textarea, select, button, [contenteditable="true"], [role="dialog"]') || document.querySelector('.overlay')) return
      const k = keys.current
      const act = listKey(e.key, e.shiftKey)
      if (!act || !k.rowIds.length) { if (e.key === 'Escape' && !k.sel.picked.length) setCursorId(null); return }
      if (act === 'down' || act === 'up' || act === 'extendDown' || act === 'extendUp') {
        const step = act === 'down' || act === 'extendDown' ? 1 : -1
        const next = k.cursor < 0 ? (step > 0 ? 0 : k.rowIds.length - 1) : Math.min(k.rowIds.length - 1, Math.max(0, k.cursor + step))
        e.preventDefault()
        if (act.startsWith('extend')) k.sel.set([...(k.cursor >= 0 ? [k.rowIds[k.cursor]!] : []), k.rowIds[next]!], true)
        setCursorId(k.rowIds[next]!)
        v.scrollToIndex(k.itemOfRow[next]!, { align: 'auto' })
        return
      }
      if (k.cursor < 0) return
      e.preventDefault()
      const id = k.rowIds[k.cursor]!
      if (act === 'toggle') k.check(k.cursor, false, false)
      else if (act === 'family') k.takeFamily(id)
      else navigate({ name: 'issue', id })
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [v])

  if (!items.length) return <div className="view-empty muted">No issues match this view.</div>
  return (
    <>
    <div className={`view-scroll${picked.length ? ' selecting' : ''}`} ref={scroller} role="list">
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map((vi) => {
          const it = items[vi.index]!
          const style = { position: 'absolute' as const, top: 0, left: 0, right: 0, height: ROW, transform: `translateY(${vi.start}px)` }
          if (it.kind === 'group') {
            const gids = groupIds.get(it.group.key) ?? []
            const gOn = gids.length > 0 && gids.every((x) => selected.has(x))
            return (
              <div key={`g:${it.group.key}`} className="list-group" style={style} role="listitem">
                {gids.length > 0 && <input type="checkbox" className="row-check group-check" checked={gOn} aria-label={`Select all ${gids.length} in ${it.group.label}`}
                  ref={(el) => { if (el) el.indeterminate = !gOn && gids.some((x) => selected.has(x)) }} onChange={() => sel.set(gids, !gOn)} />}
                <button className={`tree-toggle${it.collapsed ? '' : ' open'}`} aria-label={it.collapsed ? 'Expand group' : 'Collapse group'} onClick={() => toggle(it.group.key)}><Icon name="chevron" size={12} /></button>
                <GroupIcon by={display.groupBy} group={it.group} config={config} />
                <span className="group-label">{it.group.label}</span>
                <span className="count">{it.group.issues.length}</span>
                {display.groupBy === 'status' && <a className="icon-button group-add" href={href({ name: 'new' })} aria-label={`New issue in ${it.group.label}`}><Icon name="plus" size={12} /></a>}
              </div>
            )
          }
          const i = it.issue
          const ri = rowIndexAt.get(vi.index)!
          const on = selected.has(i.id)
          return [
            <a key={`r:${i.id}:${vi.index}`} className={`list-row${it.kids ? ' parent' : ''}${on ? ' selected' : ''}${ri === cursor ? ' cursor' : ''}`} style={style} href={href({ name: 'issue', id: i.id })}
              role="listitem" aria-level={it.depth + 1} onClick={(e) => { if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); navigate({ name: 'issue', id: i.id }) } }}>
              {it.rails.map((on, k) => <span key={k} className={`tree-guide${k === it.depth - 1 ? (on ? ' tee' : ' end') : on ? ' rail' : ''}`} aria-hidden="true" />)}
              {tree && (it.kids > 0
                ? <button type="button" className={`tree-toggle${folded.has(i.id) ? '' : ' open'}`} aria-expanded={!folded.has(i.id)} aria-label={`${folded.has(i.id) ? 'Show' : 'Hide'} sub-issues of ${i.id}`}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); fold(i.id) }}><Icon name="chevron" size={12} /></button>
                : <span className="tree-toggle" aria-hidden="true" />)}
              {props.has('priority') && <PriorityIcon priority={i.priority} />}
              {props.has('id') && <span className="id">{i.id}</span>}
              {props.has('status') && <StatusIcon status={i.status} config={config} />}
              <span className="title">{i.title}</span>
              <ProgressPill done={i.progress.done} total={i.progress.total} config={config} />
              {it.via && (
                <span className="via" role="link" tabIndex={0} title={`Sub-issue of ${it.via.id} ${it.via.title} (${it.via.status})`}
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); navigate({ name: 'issue', id: it.via!.id }) }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); navigate({ name: 'issue', id: it.via!.id }) } }}>
                  <ConceptIcon concept="parent" size={12} /><StatusIcon status={it.via.status} config={config} size={12} /><span className="t">{it.via.title}</span>
                </span>
              )}
              <span className="cells"><PropertyCells issue={i} props={props} ctx={cells} /></span>
            </a>,
            <input key={`c:${i.id}:${vi.index}`} type="checkbox" className="row-check" style={{ top: vi.start + (ROW - 14) / 2 }} checked={on}
              aria-label={`Select ${i.id}`} title={it.kids ? 'Option-click to select it with its sub-issues' : undefined} onChange={() => {}} onClick={(e) => check(ri, e.shiftKey, e.altKey)} />,
          ]
        })}
      </div>
    </div>
    {picked.length > 0 && <BulkBar ids={picked} byId={byId} onClear={clear} kids={kidsToAdd.length} onAddKids={addKids} />}
    </>
  )
}
