import type { CiBadge, CiStatus } from '../../src/model'
import { ciDetail, ciTitle, ciTone } from '../ci'

/** A small dot for rows with a PR: its colour is the checks, the tooltip says the PR and its state. */
export function CiDot({ ci }: { ci: CiBadge | undefined }) {
  if (!ci) return null
  const title = ciTitle(ci)
  return <span className={`ci-dot ${ciTone(ci)}${ci.state === 'merged' || ci.state === 'closed' ? ` ${ci.state}` : ''}`} title={title} aria-label={title} role="img" />
}

/** The issue page's badge for one PR link: state pill, checks, failing check names, last checked. */
export function CiBadgeLine({ status, now }: { status: CiStatus; now: number }) {
  const d = ciDetail(status, now)
  return (
    <div className="ci-line" title={`Last checked ${status.checkedAt}`}>
      <span className={`pill ci-state ${status.state}`}>{d.state}</span>
      <span className={`ci-checks ${ciTone(status)}`}><CiDot ci={status} />{d.checks}</span>
      {d.failing && <span className="ci-failing">{d.failing}</span>}
      {d.checked && <span className="ci-when">{d.checked}</span>}
    </div>
  )
}
