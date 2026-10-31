/** Property pills shared by list rows and board cards (columns come from `display.properties`). */
import type { IssueSummary, LabelDef, Project } from '../../src/model'
import { Icon } from '../components/icons'
import { CiDot } from '../components/Ci'
import { relTime } from '../home'

export interface CellCtx {
  labels: Map<string, LabelDef>
  projects: Map<string, Project>
  /** When the issue entered its current status. */
  since: (i: IssueSummary) => string
  now: number
}

export const shortDate = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function LabelPills({ issue, ctx }: { issue: IssueSummary; ctx: CellCtx }) {
  if (!issue.labels.length) return null
  // A group's labels fold into one pill ("Docs, API").
  const groups = new Map<string, { names: string[]; color: string }>()
  for (const l of issue.labels) {
    const def = ctx.labels.get(l)
    const g = def?.group ?? (l.includes('/') ? l.slice(0, l.indexOf('/')) : '')
    const name = g && l.startsWith(`${g}/`) ? l.slice(g.length + 1) : l
    const key = g || `\u0000${l}`
    const e = groups.get(key)
    if (e) e.names.push(name)
    else groups.set(key, { names: [name], color: def?.color ?? 'var(--faint)' })
  }
  return (
    <>
      {[...groups.entries()].map(([k, e]) => (
        <span key={k} className="pill label-pill" title={issue.labels.join(', ')}>
          <span className="swatch round" style={{ background: e.color }} />{e.names.slice(0, 2).join(', ')}{e.names.length > 2 ? `, +${e.names.length - 2}` : ''}
        </span>
      ))}
    </>
  )
}

/** The right-hand properties of a row / the chips of a card. */
export function PropertyCells({ issue, props, ctx }: { issue: IssueSummary; props: Set<string>; ctx: CellCtx }) {
  const project = issue.project !== '_none' ? ctx.projects.get(issue.project) : undefined
  const overdue = issue.due && issue.due < new Date(ctx.now).toISOString().slice(0, 10)
  return (
    <>
      <CiDot ci={issue.ci} />
      {props.has('labels') && <LabelPills issue={issue} ctx={ctx} />}
      {props.has('milestone') && issue.milestone && <span className="pill"><Icon name="milestone" size={11} /> {issue.milestone}</span>}
      {props.has('project') && project && <span className="pill"><span className="swatch round" style={{ background: project.color ?? 'var(--accent)' }} />{project.name}</span>}
      {props.has('due') && issue.due && <span className={`pill${overdue ? ' overdue' : ''}`}><Icon name="calendar" size={11} /> {shortDate(issue.due)}</span>}
      {props.has('links') && issue.links.length > 0 && <span className="pill" title={issue.links.map((l) => l.title || l.url).join('\n')}><Icon name="link" size={11} /> {issue.links.length}</span>}
      {props.has('time') && <span className="pill faint" title="Time in status">{relTime(ctx.since(issue), ctx.now)}</span>}
      {props.has('created') && <span className="date" title={`Created ${issue.created}`}>{shortDate(issue.created)}</span>}
      {props.has('updated') && <span className="date" title={`Updated ${issue.updated}`}>{shortDate(issue.updated)}</span>}
    </>
  )
}
