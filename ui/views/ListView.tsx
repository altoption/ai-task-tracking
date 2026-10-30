/**
 * The list: collapsible groups, rows virtualized with @tanstack/react-virtual so 10k issues
 * scroll smoothly, sub-issues indented under their parent with out-of-group ancestors dimmed for context.
 */
import { useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Config, IssueSummary, ViewDisplay } from '../../src/model'
import { PriorityIcon, StatusIcon, Icon } from '../components/icons'
import { href, navigate } from '../router'
import { listRows, type ListRow, type ViewGroup } from '../viewModel'
import { PropertyCells, ProgressPill, type CellCtx } from './IssueCells'

type Item = { kind: 'group'; group: ViewGroup; collapsed: boolean } | ({ kind: 'row' } & ListRow)
const ROW = 40

export function GroupIcon({ by, group, config }: { by: string; group: { key: string }; config: Config | null }) {
  if (by === 'status') return <StatusIcon status={group.key} config={config} />
  if (by === 'priority') return <PriorityIcon priority={Number(group.key)} />
  if (by === 'project') return <Icon name="project" />
  if (by === 'parent') return <Icon name="issues" />
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
  const items = useMemo(() => {
    const out: Item[] = []
    for (const g of groups) {
      const isCollapsed = collapsed.has(g.key)
      if (grouped) out.push({ kind: 'group', group: g, collapsed: isCollapsed })
      if (isCollapsed) continue
      for (const r of listRows(g.issues, byId, display.showSubIssues)) out.push({ kind: 'row', ...r })
    }
    return out
  }, [groups, collapsed, byId, display.showSubIssues, grouped])
  const v = useVirtualizer({ count: items.length, getScrollElement: () => scroller.current, estimateSize: () => ROW, overscan: 12 })
  const props = useMemo(() => new Set(display.properties), [display.properties])
  const toggle = (key: string) => setCollapsed((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n })

  if (!items.length) return <div className="view-empty muted">No issues match this view.</div>
  return (
    <div className="view-scroll" ref={scroller} role="list">
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
          return (
            <a key={`r:${i.id}:${vi.index}`} className={`list-row${it.context ? ' context' : ''}`} style={{ ...style, paddingLeft: 20 + it.depth * 26 }} href={href({ name: 'issue', id: i.id })}
              role="listitem" onClick={(e) => { if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); navigate({ name: 'issue', id: i.id }) } }}>
              {props.has('priority') && <PriorityIcon priority={i.priority} />}
              {props.has('id') && <span className="id">{i.id}</span>}
              {props.has('status') && <StatusIcon status={i.status} config={config} />}
              <span className="title">{i.title}</span>
              <ProgressPill issue={i} />
              <span className="cells"><PropertyCells issue={i} props={props} ctx={cells} /></span>
            </a>
          )
        })}
      </div>
    </div>
  )
}
