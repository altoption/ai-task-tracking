/**
 * The board: columns from `groupBy`, optional swimlanes from `rowsBy`, cards dragged between
 * cells call `save_issue` (status / priority / project / labels for the column, parent / project for the row).
 * Empty columns go to a "Hidden columns" panel unless shown. Swimlanes are virtualized (10k issues by parent means
 * thousands of rows); each cell renders 50 cards, then "Show more".
 */
import { useMemo, useRef, useState, type DragEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Config, IssueSummary, ViewDisplay } from '../../src/model'
import { Icon, PriorityIcon, ProgressPill, StatusIcon } from '../components/icons'
import { href, navigate } from '../router'
import { swimlanes, NONE, type ViewGroup, type ViewCtx } from '../viewModel'
import { GroupIcon } from './ListView'
import { PropertyCells, shortDate, type CellCtx } from './IssueCells'

const PAGE = 50

export function BoardView({ groups, hidden, display, ctx, config, cells, onDrop }: {
  groups: ViewGroup[]
  hidden: { key: string; label: string }[]
  display: ViewDisplay
  ctx: ViewCtx & { byId: ReadonlyMap<string, IssueSummary> }
  config: Config | null
  cells: CellCtx
  onDrop: (issue: IssueSummary, group: string, row: string, fromRow: string) => void
}) {
  const rowsBy = display.rowsBy && display.rowsBy !== NONE ? display.rowsBy : null
  const lanes = useMemo(() => (rowsBy ? swimlanes(groups, rowsBy, ctx, display.orderBy, !!display.showEmptyRows) : [{ key: 'all', label: '', count: 0 }]), [groups, rowsBy, ctx, display.orderBy, display.showEmptyRows])
  const cellsByKey = useMemo(() => {
    const m = new Map<string, IssueSummary[]>()
    for (const g of groups) {
      if (g.rows) for (const r of g.rows) m.set(`${g.key}\u0000${r.key}`, r.issues)
      else m.set(`${g.key}\u0000all`, g.issues)
    }
    return m
  }, [groups])
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [more, setMore] = useState<Record<string, number>>({})
  const [over, setOver] = useState<string | null>(null)
  const [dragging, setDragging] = useState<{ issue: IssueSummary; row: string } | null>(null)
  const props = useMemo(() => new Set(display.properties), [display.properties])
  const cols = groups.length
  const grid = { gridTemplateColumns: `repeat(${cols}, minmax(260px, 340px))` }
  const scroller = useRef<HTMLDivElement>(null)
  const v = useVirtualizer({
    count: lanes.length, getScrollElement: () => scroller.current, estimateSize: () => 170, overscan: 4, gap: 6,
    getItemKey: (n) => lanes[n]!.key,
  })

  const drop = (g: string, r: string) => (e: DragEvent) => {
    e.preventDefault()
    setOver(null)
    const from = dragging
    setDragging(null)
    if (from) onDrop(from.issue, g, r, from.row)
  }

  if (!groups.length) return <div className="view-empty muted">No issues match this view.</div>
  return (
    <div className="board-wrap">
      <div className="view-scroll board-scroll" ref={scroller}>
        <div className="board" style={{ width: 'max-content' }}>
          <div className="board-head" style={grid}>
            {groups.map((g) => (
              <div key={g.key} className="board-colhead">
                <GroupIcon by={display.groupBy} group={g} config={config} />
                <span className="group-label">{g.label}</span>
                <span className="count">{g.issues.length}</span>
              </div>
            ))}
          </div>
          <div className="lanes" style={{ height: v.getTotalSize(), position: 'relative' }}>
          {v.getVirtualItems().map((vi) => {
            const lane = lanes[vi.index]!
            const isCollapsed = collapsed.has(lane.key)
            const parent = rowsBy === 'parent' && lane.key !== NONE ? ctx.byId.get(lane.key) : undefined
            return (
              <section key={vi.key} className="lane" data-index={vi.index} ref={v.measureElement}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}>
                {rowsBy && (
                  <div className="lane-head">
                    <button className={`tree-toggle${isCollapsed ? '' : ' open'}`} aria-label={isCollapsed ? 'Expand row' : 'Collapse row'}
                      onClick={() => setCollapsed((s) => { const n = new Set(s); if (n.has(lane.key)) n.delete(lane.key); else n.add(lane.key); return n })}>
                      <Icon name="chevron" size={12} />
                    </button>
                    {parent ? (
                      <a href={href({ name: 'issue', id: parent.id })} className="lane-title">
                        <StatusIcon status={parent.status} config={config} /><span className="id">{parent.id}</span><span className="t">{parent.title}</span>
                      </a>
                    ) : <span className="lane-title"><span className="t">{lane.label}</span></span>}
                    <span className="count">{lane.count}</span>
                  </div>
                )}
                {!isCollapsed && (
                  <div className="lane-cells" style={grid}>
                    {groups.map((g) => {
                      const key = `${g.key}\u0000${lane.key}`
                      const list = cellsByKey.get(key) ?? []
                      const shown = more[key] ?? PAGE
                      return (
                        <div key={key} className={`board-cell${over === key ? ' over' : ''}`}
                          onDragOver={(e) => { e.preventDefault(); if (over !== key) setOver(key) }}
                          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === key ? null : o)) }}
                          onDrop={drop(g.key, lane.key)}>
                          {list.slice(0, shown).map((i) => <Card key={i.id} issue={i} props={props} config={config} cells={cells} onDrag={(x) => setDragging(x && { issue: x, row: lane.key })} />)}
                          {list.length > shown && <button className="home-more" onClick={() => setMore((m) => ({ ...m, [key]: shown + PAGE }))}>Show {Math.min(PAGE, list.length - shown)} more of {list.length - shown}</button>}
                        </div>
                      )
                    })}
                  </div>
                )}
              </section>
            )
          })}
          </div>
        </div>
      </div>
      {hidden.length > 0 && (
        <aside className="hidden-cols">
          <div className="muted small">Hidden columns</div>
          {hidden.map((h) => (
            <div key={h.key} className="hidden-col"><GroupIcon by={display.groupBy} group={h} config={config} /><span className="group-label">{h.label}</span><span className="count">0</span></div>
          ))}
        </aside>
      )}
    </div>
  )
}

function Card({ issue: i, props, config, cells, onDrag }: { issue: IssueSummary; props: Set<string>; config: Config | null; cells: CellCtx; onDrag: (i: IssueSummary | null) => void }) {
  return (
    <a className="card view-card" href={href({ name: 'issue', id: i.id })} draggable
      onClick={(e) => { if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); navigate({ name: 'issue', id: i.id }) } }}
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', i.id); e.dataTransfer.effectAllowed = 'move'; onDrag(i) }}
      onDragEnd={() => onDrag(null)}>
      {props.has('id') && <span className="id">{i.id}</span>}
      <span className="card-title"><StatusIcon status={i.status} config={config} /><span className="t">{i.title}</span></span>
      <span className="card-props">
        {props.has('priority') && <span className="pill icon-pill"><PriorityIcon priority={i.priority} size={12} /></span>}
        <PropertyCells issue={i} props={withoutDates(props)} ctx={cells} />
        <ProgressPill done={i.progress.done} total={i.progress.total} config={config} />
      </span>
      {props.has('created') && <span className="card-date">Created {shortDate(i.created)}</span>}
      {props.has('updated') && <span className="card-date">Updated {shortDate(i.updated)}</span>}
    </a>
  )
}

const DATE_PROPS = new Set(['created', 'updated'])
const memo = new WeakMap<Set<string>, Set<string>>()
function withoutDates(props: Set<string>): Set<string> {
  let s = memo.get(props)
  if (!s) { s = new Set([...props].filter((p) => !DATE_PROPS.has(p))); memo.set(props, s) }
  return s
}
