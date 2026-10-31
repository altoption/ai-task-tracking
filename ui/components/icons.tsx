import type { Config, StatusDef } from '../../src/model'

/**
 * Status glyphs. Every issue is a circle: an outline is open, a solid disc is closed, and the shape (not the color)
 * carries the state, so a theme that gives two statuses one color still tells them apart.
 */
export type StatusGlyph = 'backlog' | 'todo' | 'progress' | 'waiting' | 'done' | 'canceled' | 'duplicate'

const statusDef = (status: string, config: Config | null): StatusDef =>
  config?.statuses.find((s) => s.name === status) ?? { name: status, type: 'unstarted', color: 'var(--muted)' }

/**
 * The glyph for a status. `started` statuses are told apart by name, not type: one of `config.needsYou.statuses`
 * (Waiting, In Review…) is paused (`waiting`); every other started status (In Progress, custom ones) is `progress`.
 */
export function statusGlyph(status: string, config: Config | null): StatusGlyph {
  switch (statusDef(status, config).type) {
    case 'backlog': return 'backlog'
    case 'started': {
      // A hand-edited config.yml may hold anything here (`statuses: null`): only an array counts.
      const paused = config?.needsYou?.statuses
      return Array.isArray(paused) && paused.includes(status) ? 'waiting' : 'progress'
    }
    case 'completed': return 'done'
    case 'canceled': return 'canceled'
    case 'duplicate': return 'duplicate'
    default: return 'todo'
  }
}

/** Status glyph in a 14×14 viewBox. Marks inside a solid disc are drawn in the page background (`--bg`). */
export function StatusIcon({ status, config, size = 14 }: { status: string; config: Config | null; size?: number }) {
  const def = statusDef(status, config)
  // A theme may recolor a status type (--status-<type>, ui/theme.ts); otherwise the status's own color.
  const c = `var(--status-${def.type}, ${def.color})`
  const common = { width: size, height: size, viewBox: '0 0 14 14', 'aria-label': status, role: 'img' as const, className: 'status-icon' }
  const ring = <circle cx="7" cy="7" r="5.5" fill="none" stroke={c} strokeWidth="1.5" />
  const disc = <circle cx="7" cy="7" r="6.25" fill={c} />
  switch (statusGlyph(status, config)) {
    case 'backlog': // 12 round dots: the circumference 2π·5.5 ≈ 34.56 has one every 2.88
      // A dash of 0.001, not 0: every engine (WebKit too) draws round caps on it, and it looks the same.
      return <svg {...common}><circle cx="7" cy="7" r="5.5" fill="none" stroke={c} strokeWidth="1.6" strokeLinecap="round" strokeDasharray="0.001 2.879" transform="rotate(-90 7 7)" /></svg>
    case 'todo':
      return <svg {...common}>{ring}</svg>
    case 'progress':
      return <svg {...common}>{ring}<circle cx="7" cy="7" r="2.25" fill={c} /></svg>
    case 'waiting':
      return <svg {...common}>{ring}<path d="M5.75 5.1v3.8M8.25 5.1v3.8" stroke={c} strokeWidth="1.5" strokeLinecap="round" /></svg>
    case 'done':
      return <svg {...common}>{disc}<path d="M4.4 7.2 6.2 9 9.7 5.3" fill="none" stroke="var(--bg)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
    case 'canceled':
      return <svg {...common}>{disc}<path d="M4.6 7h4.8" stroke="var(--bg)" strokeWidth="1.5" strokeLinecap="round" /></svg>
    case 'duplicate':
      return <svg {...common}><circle cx="8.6" cy="5.4" r="4.4" fill="none" stroke={c} strokeWidth="1.3" opacity=".75" /><circle cx="5.9" cy="8.1" r="4.9" fill={c} /></svg>
  }
}

const RING_R = 5.25
const RING_W = 2
const RING_C = 2 * Math.PI * RING_R
/** The shortest arc that shows above 0, and the gap that stays open below 100%: 20° each. */
export const RING_MIN = 20 / 360

/** done/total made safe to show: NaN, infinite or negative counts are 0, and done never exceeds total. */
export function clampProgress(done: number, total: number): { done: number; total: number } {
  const t = Number.isFinite(total) && total > 0 ? total : 0
  const d = Number.isFinite(done) && done > 0 ? done : 0
  return { done: Math.min(d, t), total: t }
}

/**
 * The share of the circle the progress arc covers (round caps included): 0 at 0, at least 20° above 0, at most 340°
 * below 100%, and 1 (a closed ring) when all are done.
 */
export function progressArc(done: number, total: number): number {
  const p = clampProgress(done, total)
  const f = p.total > 0 ? p.done / p.total : 0
  if (f <= 0) return 0
  if (f >= 1) return 1
  return Math.min(Math.max(f, RING_MIN), 1 - RING_MIN)
}

/** The color a finished ring closes in: the theme's `completed` override, else the first Done-type status's color. */
export function doneColor(config: Config | null): string {
  const def = config?.statuses.find((s) => s.type === 'completed')
  return `var(--status-completed, ${def?.color ?? 'var(--accent)'})`
}

/**
 * The one progress glyph (list, board, issue page, project page) and the only glyph with a fill that grows. The arc
 * starts at 12 o'clock and runs clockwise in `--accent` over a track of the text color at 18%; a finished ring closes
 * in the Done color.
 *
 * Its `<title>` is both the accessible name and the tooltip, the one place the figure is spoken. `decorative` hides it
 * from assistive tech where visible text next to it already says the same ("2/9 issues done").
 */
export function ProgressRing({ done, total, config, size = 14, noun = 'sub-issues', decorative = false }: {
  done: number; total: number; config: Config | null; size?: number; noun?: string; decorative?: boolean
}) {
  const p = clampProgress(done, total)
  const shown = progressArc(p.done, p.total)
  const label = `${p.done} of ${p.total} ${noun} done`
  // A round cap reaches RING_W / 2 past each end of the dash: shorten the dash by RING_W and start it RING_W / 2 in,
  // so the arc you see (caps included) starts at 12 o'clock and covers exactly `shown` of the circle. The shortest
  // dash is 0.001, not 0, so every engine (WebKit too) draws its round caps.
  const dash = Math.max(0.001, shown * RING_C - RING_W)
  const a11y = decorative ? { 'aria-hidden': true as const } : { role: 'img' as const }
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" {...a11y} className="progress-ring">
      <title>{label}</title>
      <circle cx="7" cy="7" r={RING_R} fill="none" stroke="var(--text)" strokeOpacity=".18" strokeWidth={RING_W} />
      {shown >= 1
        ? <circle className="arc done" cx="7" cy="7" r={RING_R} fill="none" stroke={doneColor(config)} strokeWidth={RING_W} />
        : shown > 0 && (
          <circle className="arc" cx="7" cy="7" r={RING_R} fill="none" stroke="var(--accent)" strokeWidth={RING_W} strokeLinecap="round"
            strokeDasharray={`${dash.toFixed(3)} ${RING_C.toFixed(3)}`} strokeDashoffset={(-RING_W / 2).toFixed(3)} transform="rotate(-90 7 7)" />
        )}
    </svg>
  )
}

/**
 * The ring plus the exact count, as a pill: the ring is the glance, the count the figure (hidden from assistive tech,
 * which reads the ring's title once). Nothing without sub-issues.
 */
export function ProgressPill({ done, total, config }: { done: number; total: number; config: Config | null }) {
  const p = clampProgress(done, total)
  if (!p.total) return null
  return (
    <span className="pill progress">
      <ProgressRing done={p.done} total={p.total} config={config} size={12} />
      <span aria-hidden="true">{p.done}/{p.total}</span>
    </span>
  )
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

/** A circle as a path (for the stroke icons, which are one path each). */
const circle = (cx: number, cy: number, r: number) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`

/**
 * Small stroke icons for the sidebar, menus and buttons: 16-px viewBox, stroke 1.3, round caps and joins. One shape per
 * concept; which concept uses which icon is `CONCEPT_ICON` below.
 */
export const ICON_PATHS: Record<string, string> = {
  home: 'M2.5 7.2 8 2.8l5.5 4.4V13a.5.5 0 0 1-.5.5H10V10H6v3.5H3a.5.5 0 0 1-.5-.5z',
  issues: 'M3 3.5h10M3 8h10M3 12.5h6',
  // A ring with a center dot, like the In Progress glyph, in the text color: "status" in general.
  status: `${circle(8, 8, 5.5)}${circle(8, 8, 1.2)}`,
  // Three signal bars, PriorityIcon in stroke form.
  priority: 'M3.5 13v-3M8 13V7M12.5 13V3',
  // A tag with its hole.
  label: 'M2.5 3v4.3l6.2 6.2 4.8-4.8-6.2-6.2H3a.5.5 0 0 0-.5.5zM5.4 5.4h.01',
  // Two nodes joined by a line.
  relations: `${circle(4.4, 11.6, 2.2)}${circle(11.6, 4.4, 2.2)}M6 10l4-4`,
  // A parent node with a child branch.
  parent: `${circle(4.6, 4.2, 2.1)}M4.6 6.3v3.4a2 2 0 0 0 2 2h2.3${circle(11.2, 11.7, 2.1)}`,
  // A folder.
  workspace: 'M2 4.5a1 1 0 0 1 1-1h3.1l1.5 1.6H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z',
  // A page with text lines.
  content: 'M4 1.8h5.3l3.2 3.2v8.7a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2.3a.5.5 0 0 1 .5-.5zM9.2 1.8v3.3h3.3M5.8 8h4.4M5.8 10.5h4.4',
  // A circle half hatched: light and dark, for themes.
  theme: `${circle(8, 8, 5.5)}M8 2.5v11M8 5.2h4.6M8 8h5.5M8 10.8h4.6`,
  // A gear.
  settings: `${circle(8, 8, 2.2)}${circle(8, 8, 4.8)}M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M3.5 12.5l1.1-1.1M11.4 4.6l1.1-1.1`,
  project: 'M8 1.8 13.5 5v6L8 14.2 2.5 11V5zM2.5 5 8 8.2 13.5 5M8 8.2v6',
  view: 'M2 6 8 3l6 3-6 3zM2 9.5 8 12.5l6-3',
  search: 'M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM10.6 10.6 14 14',
  new: 'M11.5 2.5l2 2L7 11l-2.6.6L5 9zM13 9.5V13a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 3 13V4a.5.5 0 0 1 .5-.5H7',
  star: 'M8 2l1.8 3.8 4.1.5-3 2.9.8 4.1L8 11.3l-3.7 2 .8-4.1-3-2.9 4.1-.5z',
  warn: 'M8 2.5 14 13H2zM8 6.5v3M8 11.3v.2',
  chevron: 'M4.5 6 8 9.5 11.5 6',
  filter: 'M2.5 4h11M4.5 8h7M6.5 12h3',
  display: 'M2.5 5h11M2.5 11h11M6 3.5v3M10 9.5v3',
  // The list layout: bulleted rows, so it isn't All issues' lines.
  list: 'M2.5 4h.01M5.5 4h8M2.5 8h.01M5.5 8h8M2.5 12h.01M5.5 12h8',
  board: 'M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z',
  plus: 'M8 3v10M3 8h10',
  link: 'M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1',
  calendar: 'M2.5 4h11v9.5h-11zM2.5 7h11M5.5 2.5v3M10.5 2.5v3',
  // A flag on a pole.
  milestone: 'M3.8 14V2.3M3.8 2.8h8.6l-2.2 3.1 2.2 3.1H3.8',
  x: 'M4 4l8 8M12 4l-8 8',
  back: 'M13 8H3.5M7.5 4 3.5 8l4 4',
  forward: 'M3 8h9.5M8.5 4l4 4-4 4',
  sidebar: 'M2.5 3.5h11v9h-11zM6.5 3.5v9',
  help: 'M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM6.2 6.3a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.3M8 11.3v.2',
}

/**
 * The icon of each concept, in one place: the sidebar, filter menu, grouping, issue properties, issue page and ⌘K all
 * pick from here, so one concept never wears two icons and two concepts never share one.
 */
export const CONCEPT_ICON = {
  home: 'home', issues: 'issues', views: 'view', project: 'project', search: 'search', filter: 'filter', display: 'display',
  status: 'status', priority: 'priority', labels: 'label', relations: 'relations', links: 'link', parent: 'parent',
  workspace: 'workspace', milestone: 'milestone', content: 'content', dates: 'calendar', theme: 'theme', settings: 'settings',
  newIssue: 'new', favorite: 'star', warning: 'warn', docs: 'help', list: 'list', board: 'board',
} as const satisfies Record<string, keyof typeof ICON_PATHS>
export type Concept = keyof typeof CONCEPT_ICON

export function Icon({ name, size = 14 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon">
      <path d={ICON_PATHS[name] ?? ''} />
    </svg>
  )
}

/** The icon of a concept (see `CONCEPT_ICON`). */
export function ConceptIcon({ concept, size = 14 }: { concept: Concept; size?: number }) {
  return <Icon name={CONCEPT_ICON[concept]} size={size} />
}
