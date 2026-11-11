/**
 * The list: collapsible groups, rows virtualized with @tanstack/react-virtual so 10k issues
 * scroll smoothly. Sub-issues form a tree under their parent (guide lines, a chevron to fold a parent away); a
 * sub-issue whose parent is in another group names it in a crumb after the title instead of repeating the parent row.
 * Rows can be selected (checkbox, shift-click for a range, ⌘A, Esc clears) and changed together in the bulk bar.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Config, IssueSummary, ViewDisplay } from '../../src/model'
import { ConceptIcon, PriorityIcon, ProgressPill, StatusIcon, Icon } from '../components/icons'
import { href, navigate } from '../router'
import { listRows, type ListRow, type ViewGroup } from '../viewModel'
import { PropertyCells, type CellCtx } from './IssueCells'
import { BulkBar } from './BulkBar'
import { clickSelect, visibleSelection } from '../bulk'

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
  const items = useMemo(() => {
    const out: Item[] = []
    for (const g of groups) {
      const isCollapsed = collapsed.has(g.key)
      if (grouped) out.push({ kind: 'group', group: g, collapsed: isCollapsed })
      if (isCollapsed) continue
      for (const r of listRows(g.issues, byId, display.showSubIssues, folded)) out.push({ kind: 'row', ...r })
    }
    return out
  }, [groups, collapsed, folded, byId, display.showSubIssues, grouped])
  const v = useVirtualizer({ count: items.length, getScrollElement: () => scroller.current, estimateSize: () => ROW, overscan: 12 })
  const props = useMemo(() => new Set(display.properties), [display.properties])
  // A slot for the fold chevron only when some row has sub-issues here, so flat lists keep their left edge.
  const tree = useMemo(() => items.some((it) => it.kind === 'row' && it.kids > 0), [items])
  const toggle = (key: string) => setCollapsed((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n })

  // Selection: ids of the visible rows in order (group headers skipped), the selected ones, and the last clicked row.
  const rowIds = useMemo(() => items.flatMap((it) => (it.kind === 'row' ? [it.issue.id] : [])), [items])
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const anchor = useRef<number | null>(null)
  const picked = useMemo(() => visibleSelection(selected, rowIds), [selected, rowIds])
  const clear = useCallback(() => { setSelected(new Set()); anchor.current = null }, [])
  const check = (rowIndex: number, shift: boolean) => {
    const from = anchor.current // read now: the updater runs later, after the anchor moves
    setSelected((s) => clickSelect(s, rowIds, rowIndex, from, shift))
    anchor.current = rowIndex
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
      if (e.key === 'Escape' && picked.length) { clear() }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && rowIds.length) { e.preventDefault(); setSelected(new Set(rowIds)) }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [picked.length, rowIds, clear])
  let rowIndex = -1
  const rowIndexAt = new Map<number, number>()
  items.forEach((it, k) => { if (it.kind === 'row') rowIndexAt.set(k, ++rowIndex) })

  if (!items.length) return <div className="view-empty muted">No issues match this view.</div>
  return (
    <>
    {picked.length > 0 && <BulkBar ids={picked} byId={byId} onDone={clear} onClear={clear} />}
    <div className={`view-scroll${picked.length ? ' selecting' : ''}`} ref={scroller} role="list">
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map((vi) => {
          const it = items[vi.index]!
          const style = { position: 'absolute' as const, top: 0, left: 0, right: 0, height: ROW, transform: `translateY(${vi.start}px)` }
          if (it.kind === 'group') {
            return (
              <div key={`g:${it.group.key}`} className="list-group" style={style} role="listitem">
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
            <a key={`r:${i.id}:${vi.index}`} className={`list-row${it.kids ? ' parent' : ''}${on ? ' selected' : ''}`} style={style} href={href({ name: 'issue', id: i.id })}
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
              aria-label={`Select ${i.id}`} onChange={() => {}} onClick={(e) => check(ri, e.shiftKey)} />,
          ]
        })}
      </div>
    </div>
    </>
  )
}
