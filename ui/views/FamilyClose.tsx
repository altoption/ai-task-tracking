import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { familyClose, type FamilyClose } from '../bulk'
import { getState, useTracker } from '../client'
import { StatusIcon } from '../components/icons'

interface Pending { ids: readonly string[]; status: string; fam: FamilyClose; go: (fam: FamilyClose) => void }
const SHOWN = 6

/**
 * Asks before a status change that also closes open sub-issues: completing a parent (the engine refuses it unless
 * the same call closes them) or canceling one (the engine cancels them with it). `ask` calls `go` right away when
 * there are none; otherwise it opens `dialog` and calls `go` with them once the owner agrees.
 */
export function useFamilyClose(): { ask: (ids: readonly string[], status: string, go: (fam: FamilyClose | null) => void) => void; dialog: ReactNode } {
  const [pending, setPending] = useState<Pending | null>(null)
  const ask = useCallback((ids: readonly string[], status: string, go: (fam: FamilyClose | null) => void) => {
    const { config, issues } = getState()
    const statuses = config?.statuses ?? []
    const fam = familyClose(ids, statuses.find((s) => s.name === status), issues.values(), statuses)
    if (fam) setPending({ ids, status, fam, go }); else go(null)
  }, [])
  const close = useCallback(() => setPending(null), [])
  return { ask, dialog: pending ? <FamilyCloseDialog pending={pending} onClose={close} /> : null }
}

function FamilyCloseDialog({ pending, onClose }: { pending: Pending; onClose: () => void }) {
  const { config, issues } = useTracker()
  const { ids, status, fam, go } = pending
  const n = fam.kids.length
  const subs = `${n} open sub-issue${n === 1 ? '' : 's'}`
  const who = ids.length === 1 ? ids[0]! : `These ${ids.length} issues`
  const complete = fam.kind === 'complete'
  const primary = useRef<HTMLButtonElement>(null)
  // The pick that opened this happens on mouse-down, and the browser moves focus after it: take focus a tick later,
  // and listen for Esc on the window so it closes wherever focus ended up.
  useEffect(() => {
    const t = setTimeout(() => primary.current?.focus(), 0)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => { clearTimeout(t); window.removeEventListener('keydown', onKey, true) }
  }, [onClose])
  const title = complete ? `${n === 1 ? '1 sub-issue is' : `${n} sub-issues are`} still open` : `This also cancels ${subs}`
  const body = complete
    ? `${who} can't be ${status} while ${n === 1 ? 'it is' : 'they are'} open. Move ${n === 1 ? 'it' : 'them'} to ${status} too?`
    : `Moving ${ids.length === 1 ? who : who.toLowerCase()} to ${status} cancels the open issues under ${ids.length === 1 ? 'it' : 'them'}. Each gets a comment with the status it had.`
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <form className="dialog family-close" role="dialog" aria-modal="true" aria-label={title}
        onSubmit={(e) => { e.preventDefault(); onClose(); go(fam) }}>
        <div className="dialog-head"><strong>{title}</strong><button type="button" className="icon-button close" onClick={onClose} aria-label="Close">×</button></div>
        <p className="family-close-body">{body}</p>
        <ul className="family-close-list">
          {fam.kids.slice(0, SHOWN).map((id) => {
            const k = issues.get(id)
            return <li key={id}><StatusIcon status={k?.status ?? ''} config={config} /><span className="id">{id}</span><span className="title">{k?.title}</span><span className="muted">{k?.status}</span></li>
          })}
          {n > SHOWN && <li className="muted">and {n - SHOWN} more</li>}
        </ul>
        <div className="dialog-foot">
          <button type="button" className="ghost-btn" onClick={onClose}>Back</button>
          <button ref={primary} type="submit" className="primary">{complete ? `Move all ${ids.length + n} to ${status}` : `Move to ${status}`}</button>
        </div>
      </form>
    </div>
  )
}
