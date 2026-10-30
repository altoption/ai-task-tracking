export type Priority = 0 | 1 | 2 | 3 | 4
export type PlanSlot = 'now' | 'next' | 'later' | null
export interface Link { title: string; url: string }
/** `client`: the agent tool that wrote (claude-code, codex, cursor, vscode, windsurf, gemini, claude-desktop), when known. */
export interface Actor { actor: 'you' | 'agent'; workspace?: string; branch?: string; session?: string; client?: string }
export interface ActivityEntry { at: string; actor: 'you' | 'agent' | string; workspace?: string; branch?: string; body: string }
export interface Issue {
  id: string; title: string; status: string; priority: Priority; labels: string[]
  parent: string | null; blockedBy: string[]; related: string[]; milestone: string | null
  due: string | null; plan: PlanSlot; links: Link[]; created: string; updated: string
  touchedBy?: Actor
  extra: Record<string, unknown> // unknown front-matter keys, preserved in order
  description: string; activity: ActivityEntry[]
  project: string // project slug (folder name), '_none' if none
  path: string // absolute file path
}

/** Wire shape for lists and live events: Issue without the heavy/internal fields, plus derived counts. */
export type IssueSummary = Omit<Issue, 'description' | 'activity' | 'extra' | 'path'> & {
  childCount: number; progress: { done: number; total: number }; blocks: string[]
  /** Every workspace that ever wrote to the issue (touchedBy + activity entries), without 'external'. */
  workspaces: string[]
  /** The worst CI status over the issue's GitHub PR links (src/engine/ci.ts), when CI status is on and known. */
  ci?: CiBadge
}

/** A GitHub PR's state and its checks (from `gh pr view`). */
export type PrState = 'open' | 'draft' | 'merged' | 'closed'
export type ChecksState = 'passing' | 'failing' | 'pending' | 'none'
/** One PR's CI status: `failing` holds up to three failing check names; `checkedAt` is when gh answered. */
export interface CiStatus { pr: number; state: PrState; checks: ChecksState; failing: string[]; checkedAt: string; mergedAt?: string }
/** The compact form for rows. */
export type CiBadge = Pick<CiStatus, 'pr' | 'state' | 'checks'>

export interface StatusDef { name: string; type: 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled' | 'duplicate'; color: string }
export interface LabelDef { name: string; group: string | null; color: string; extra?: Record<string, unknown> } // full name 'Scope/Docs' when grouped
export interface Milestone { name: string; description?: string; target?: string; extra?: Record<string, unknown> }
export interface Project {
  slug: string; name: string; key: string; status: string; color?: string
  repos: string[]; milestones: Milestone[]; description: string
  docs: { slug: string; title: string; content: string; extra?: Record<string, unknown> }[]
  extra?: Record<string, unknown> // unknown front-matter keys, preserved
}
export interface Filter {
  status?: string[]; project?: string[]; labels?: string[]; parent?: string | null; workspace?: string[]
  priority?: number[]; blocked?: boolean; query?: string; updatedAfter?: string; includeDone?: boolean
  milestone?: string[]; createdAfter?: string
  /** Blocks at least one open issue. */
  blocking?: boolean
  hasRelated?: boolean; hasLinks?: boolean
}
/** Completed-issues window of a view (display option): none, closed within the past day/week/month, or all. */
export type CompletedWindow = 'none' | 'day' | 'week' | 'month' | 'all'
export interface ViewDisplay {
  layout: 'list' | 'board'; groupBy: string; rowsBy?: string; orderBy: string; showSubIssues: boolean; properties: string[]
  showEmptyColumns?: boolean; showEmptyRows?: boolean; completed?: CompletedWindow
}
export interface View { slug: string; name: string; filter: Filter; display: ViewDisplay }
/** CI status on linked GitHub PRs (src/engine/ci.ts): off, or how often open PRs are re-checked. */
export interface CiRules { enabled: boolean; refreshMinutes: number }
/** When open work counts as stalled (src/engine/stalled.ts). 0 turns a rule off. */
export interface StalledRules { idleHours: number; windowDays: number; reopens: number; sessions: number }
export interface Config {
  port: number; statuses: StatusDef[]; workspaces: Record<string, string> // workspace -> project slug
  needsYou: { statuses: string[]; labels: string[] }; stalled: StalledRules; ci: CiRules; nextNumber: Record<string, number>
  /** The UI theme (src/engine/themes.ts): a built-in id (dark, light, system, …) or a themes/<id>.yml file. */
  theme: string
  extra?: Record<string, unknown> // unknown top-level keys, preserved
}
