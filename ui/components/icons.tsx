import type { Config, StatusDef } from '../../src/model'

/** Status glyph: dashed ring (backlog), ring (unstarted), pie (started), check (completed), cross (canceled/duplicate). */
export function StatusIcon({ status, config, size = 14 }: { status: string; config: Config | null; size?: number }) {
  const statuses = config?.statuses ?? []
  const def: StatusDef = statuses.find((s) => s.name === status) ?? { name: status, type: 'unstarted', color: 'var(--muted)' }
  // A theme may recolor a status type (--status-<type>, ui/theme.ts); otherwise the status's own color.
  const c = `var(--status-${def.type}, ${def.color})`
  const common = { width: size, height: size, viewBox: '0 0 14 14', 'aria-label': status, role: 'img' as const, className: 'status-icon' }
  switch (def.type) {
    case 'backlog':
      return <svg {...common}><circle cx="7" cy="7" r="5.5" fill="none" stroke={c} strokeWidth="1.5" strokeDasharray="1.6 1.6" /></svg>
    case 'unstarted':
      return <svg {...common}><circle cx="7" cy="7" r="5.5" fill="none" stroke={c} strokeWidth="1.5" /></svg>
    case 'started': {
      // Fill grows with the status's position among started statuses (In Progress, then Waiting…).
      const started = statuses.filter((s) => s.type === 'started')
      const frac = (Math.max(0, started.findIndex((s) => s.name === status)) + 1) / (started.length + 1)
      const a = frac * 2 * Math.PI
      const x = 7 + 3 * Math.sin(a), y = 7 - 3 * Math.cos(a)
      const d = frac >= 1 ? '' : `M7 7 L7 4 A3 3 0 ${frac > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)} Z`
      return <svg {...common}><circle cx="7" cy="7" r="5.5" fill="none" stroke={c} strokeWidth="1.5" /><path d={d} fill={c} /></svg>
    }
    case 'completed':
      return <svg {...common}><circle cx="7" cy="7" r="6.25" fill={c} /><path d="M4.4 7.2 6.2 9 9.7 5.3" fill="none" stroke="var(--bg)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
    default:
      return <svg {...common}><circle cx="7" cy="7" r="6.25" fill={c} /><path d="M5 5 9 9M9 5 5 9" stroke="var(--bg)" strokeWidth="1.5" strokeLinecap="round" /></svg>
  }
}

export const PRIORITIES = ['No priority', 'Urgent', 'High', 'Medium', 'Low'] as const

/** Priority glyph: three bars filled by level, an exclamation box for urgent, a dash for none. */
export function PriorityIcon({ priority, size = 14 }: { priority: number; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 14 14', 'aria-label': PRIORITIES[priority] ?? 'Priority', role: 'img' as const }
  if (priority === 1) return <svg {...common}><rect x="1" y="1" width="12" height="12" rx="3" fill="var(--urgent)" /><path d="M7 3.5v4.2M7 9.8v.4" stroke="var(--bg)" strokeWidth="1.6" strokeLinecap="round" /></svg>
  if (!priority) return <svg {...common}><path d="M3 7h1.5M6.25 7h1.5M9.5 7H11" stroke="var(--muted)" strokeWidth="1.4" strokeLinecap="round" /></svg>
  const on = 5 - priority // high 3 bars, medium 2, low 1
  return (
    <svg {...common}>
      {[0, 1, 2].map((k) => (
        <rect key={k} x={2 + k * 3.5} y={9 - k * 3} width="2.5" height={3 + k * 3} rx="0.8" fill={k < on ? 'var(--text)' : 'var(--faint)'} />
      ))}
    </svg>
  )
}

/** Small stroke icons for the sidebar and buttons. */
const paths: Record<string, string> = {
  home: 'M2.5 7.2 8 2.8l5.5 4.4V13a.5.5 0 0 1-.5.5H10V10H6v3.5H3a.5.5 0 0 1-.5-.5z',
  issues: 'M3 3.5h10M3 8h10M3 12.5h6',
  project: 'M8 1.8 13.5 5v6L8 14.2 2.5 11V5zM2.5 5 8 8.2 13.5 5M8 8.2v6',
  view: 'M2 6 8 3l6 3-6 3zM2 9.5 8 12.5l6-3',
  search: 'M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM10.6 10.6 14 14',
  new: 'M11.5 2.5l2 2L7 11l-2.6.6L5 9zM13 9.5V13a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 3 13V4a.5.5 0 0 1 .5-.5H7',
  star: 'M8 2l1.8 3.8 4.1.5-3 2.9.8 4.1L8 11.3l-3.7 2 .8-4.1-3-2.9 4.1-.5z',
  warn: 'M8 2.5 14 13H2zM8 6.5v3M8 11.3v.2',
  chevron: 'M4.5 6 8 9.5 11.5 6',
  filter: 'M2.5 4h11M4.5 8h7M6.5 12h3',
  display: 'M2.5 5h11M2.5 11h11M6 3.5v3M10 9.5v3',
  list: 'M2.5 4h11M2.5 8h11M2.5 12h11',
  board: 'M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z',
  plus: 'M8 3v10M3 8h10',
  link: 'M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1',
  calendar: 'M2.5 4h11v9.5h-11zM2.5 7h11M5.5 2.5v3M10.5 2.5v3',
  milestone: 'M8 2.5 13.5 8 8 13.5 2.5 8z',
  x: 'M4 4l8 8M12 4l-8 8',
  back: 'M13 8H3.5M7.5 4 3.5 8l4 4',
  forward: 'M3 8h9.5M8.5 4l4 4-4 4',
  sidebar: 'M2.5 3.5h11v9h-11zM6.5 3.5v9',
  help: 'M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM6.2 6.3a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.3M8 11.3v.2',
}
export function Icon({ name, size = 14 }: { name: keyof typeof paths | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon">
      <path d={paths[name] ?? ''} />
    </svg>
  )
}
