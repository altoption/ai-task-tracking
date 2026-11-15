import { useEffect, useRef, type ReactNode } from 'react'

/** True when the click landed on the dialog's backdrop: on the element itself, outside its box. */
export function onBackdrop(target: EventTarget | null, dialog: Element, x: number, y: number): boolean {
  if (target !== dialog) return false
  const r = dialog.getBoundingClientRect()
  return !(r.top <= y && y <= r.top + r.height && r.left <= x && x <= r.left + r.width)
}

/**
 * A modal: a native <dialog> opened with showModal(), so the browser puts it over everything, keeps Tab inside it
 * and makes the page behind inert. Esc and a click on the backdrop call `onClose`; the parent then unmounts it, and
 * focus goes back to where it was. `children` is the box (it carries the styling).
 */
export function Modal({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const d = ref.current
    if (!d) return
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!d.open) d.showModal()
    // Esc closes this and nothing else: listeners on the window (clear the selection, close a panel) don't see it.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close.current() } }
    // Other close requests the browser makes (it would close the element without telling React).
    const onCancel = (e: Event) => { e.preventDefault(); close.current() }
    // Browsers without closedby="any" (Safari): close on a backdrop click by hand.
    const onClick = (e: MouseEvent) => { if (onBackdrop(e.target, d, e.clientX, e.clientY)) close.current() }
    const native = 'closedBy' in HTMLDialogElement.prototype
    d.addEventListener('keydown', onKey)
    d.addEventListener('cancel', onCancel)
    if (!native) d.addEventListener('click', onClick)
    return () => {
      d.removeEventListener('keydown', onKey)
      d.removeEventListener('cancel', onCancel)
      d.removeEventListener('click', onClick)
      if (d.open) d.close()
      if (before?.isConnected) before.focus()
    }
  }, [])
  // closedby isn't in React's types yet; the attribute passes through as written.
  return <dialog ref={ref} className="modal" aria-label={label} {...{ closedby: 'any' }}>{children}</dialog>
}
