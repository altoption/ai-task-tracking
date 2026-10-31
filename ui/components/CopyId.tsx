import { useEffect, useRef, useState } from 'react'
import { ConceptIcon } from './icons'

/** Copy to the clipboard; false when it is unavailable or refused, so the page can say so. */
export async function copyText(text: string, clipboard: Pick<Clipboard, 'writeText'> | undefined = navigator.clipboard): Promise<boolean> {
  try { await clipboard!.writeText(text); return true } catch { return false }
}

/** The issue's ID in the breadcrumb: click to copy it. */
export function CopyId({ id }: { id: string }) {
  const [message, setMessage] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async () => {
    const ok = await copyText(id)
    setMessage(ok ? 'Copied' : "Couldn't copy")
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setMessage(''), 1500)
  }
  return (
    <>
      <button type="button" className="id copy-id" onClick={() => void copy()} title="Copy ID" aria-label={`Copy ID ${id}`}>
        {id}<ConceptIcon concept="copy" size={12} />
      </button>
      <span className="copy-status" role="status">{message}</span>
    </>
  )
}
