import { useEffect, useRef, useState, type ReactNode } from 'react'

/** A toolbar button with a popover below it; closes on outside click or Escape. `children` may take `close`. */
export function Popover({ label, button, className, active, children }: {
  label: string
  button: ReactNode
  className?: string
  /** Show the button's "something is set" dot. */
  active?: boolean
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    addEventListener('mousedown', onDown)
    addEventListener('keydown', onKey, true)
    return () => { removeEventListener('mousedown', onDown); removeEventListener('keydown', onKey, true) }
  }, [open])
  return (
    <div className={`popover ${className ?? ''}`} ref={box}>
      <button type="button" className={`tool-button${open ? ' open' : ''}`} aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        {button}
        {active && <span className="tool-dot" aria-hidden="true" />}
      </button>
      {open && <div className="menu popover-panel" role="dialog" aria-label={label}>{children(() => setOpen(false))}</div>}
    </div>
  )
}
