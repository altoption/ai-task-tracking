/** CI status of linked GitHub PRs as the UI shows it (the engine fetches it: src/engine/ci.ts). Pure. */
import type { CiBadge, CiStatus } from '../src/model'
import { relTime } from './home'

/** The dot's tone: red failing, amber pending, green passing, grey no checks; merged and closed PRs say so. */
export function ciTone(b: Pick<CiBadge, 'checks' | 'state'>): 'fail' | 'pending' | 'pass' | 'none' {
  return b.checks === 'failing' ? 'fail' : b.checks === 'pending' ? 'pending' : b.checks === 'passing' ? 'pass' : 'none'
}

const CHECKS: Record<CiBadge['checks'], string> = { failing: 'checks failing', pending: 'checks running', passing: 'checks passing', none: 'no checks' }

/** "PR #12 open · checks failing" (row tooltips and the dot's label). */
export function ciTitle(b: CiBadge): string {
  return `PR #${b.pr} ${b.state} · ${CHECKS[b.checks]}`
}

/**
 * The issue page's line for one PR: state, checks, the failing check names, and when it was checked ("2m ago").
 * A merged or closed PR's failing checks read "checks failed" (they won't run again). Unexpected data shows as blank.
 */
export function ciDetail(s: CiStatus, nowMs: number): { state: string; checks: string; failing: string; checked: string } {
  const age = typeof s.checkedAt === 'string' ? relTime(s.checkedAt, nowMs) : ''
  const done = s.state === 'merged' || s.state === 'closed'
  const checks = s.checks === 'failing' && done ? 'checks failed' : (Object.hasOwn(CHECKS, s.checks) ? CHECKS[s.checks] : '')
  return {
    state: typeof s.state === 'string' ? s.state : '',
    checks,
    failing: Array.isArray(s.failing) ? s.failing.filter((x) => typeof x === 'string').join(', ') : '',
    checked: age ? (age === 'now' ? 'checked just now' : `checked ${age} ago`) : '',
  }
}
