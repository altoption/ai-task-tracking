/**
 * The quiet line on a page opened by direct link whose project is hidden (`hiddenProjects` in config.yml), with
 * Unhide. Unhiding refetches the snapshot everywhere (the engine's `meta` event), so everything comes back live.
 */
import { useState } from 'react'
import { NO_PROJECT, setProjectHidden } from '../client'
import { ConceptIcon } from '../components/icons'

export function HiddenNotice({ slug }: { slug: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const unhide = async () => {
    setBusy(true); setError('')
    try { await setProjectHidden(slug, false) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    setBusy(false)
  }
  return (
    <div className="hidden-note" role="note">
      <ConceptIcon concept="project" size={12} />
      <span>{slug === NO_PROJECT ? 'Issues without a project are hidden.' : 'This project is hidden.'}</span>
      <button type="button" className="ghost-btn inline" disabled={busy} onClick={() => void unhide()}>{busy ? 'Unhiding…' : 'Unhide'}</button>
      {error && <span className="form-error" role="alert">{error}</span>}
    </div>
  )
}
