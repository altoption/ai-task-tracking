import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { filterOptions, type Option } from '../issuePage'

export type PickOption = Option & { icon?: ReactNode }

/**
 * A trigger button with a type-ahead popover (property dropdowns).
 * Single select closes on pick; `multi` toggles and stays open. `options` may be a function of the query
 * (issue pickers search as you type, via `onQuery`); otherwise options are filtered locally. `create` offers a new value
 * for a query nothing matches exactly (e.g. a new label).
 */
export function Picker({ label, trigger, options, selected, multi, onPick, create, onQuery, placeholder, className }: {
  label: string
  trigger: ReactNode
  options: PickOption[] | ((q: string) => PickOption[])
  selected: string[]
  multi?: boolean
  onPick: (value: string, on: boolean) => void
  create?: (q: string) => PickOption | null
  /** Told the query as it changes (e.g. to start a server search that updates `options`). */
  onQuery?: (q: string) => void
  placeholder?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)

  const shown = useMemo(() => {
    if (!open) return []
    const base = typeof options === 'function' ? options(q) : filterOptions(options, q)
    const extra = create && q.trim() && !base.some((o) => o.value.toLowerCase() === q.trim().toLowerCase()) ? create(q.trim()) : null
    return extra ? [...base, extra] : base
  }, [open, options, q, create])

  useEffect(() => { setCursor(0) }, [q, open])
  useEffect(() => { if (open) onQuery?.(q) }, [q, open])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    addEventListener('mousedown', onDown)
    return () => removeEventListener('mousedown', onDown)
  }, [open])
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [cursor])

  const pick = (o: PickOption) => {
    const on = !selected.includes(o.value)
    onPick(o.value, multi ? on : true)
    if (!multi) { setOpen(false); setQ('') }
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, shown.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); const o = shown[cursor]; if (o) pick(o) }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); setQ('') }
  }

  let lastGroup: string | null | undefined
  return (
    <div className={`picker ${className ?? ''}`} ref={box}>
      <button type="button" className="prop-button" aria-haspopup="listbox" aria-expanded={open} aria-label={label} onClick={() => setOpen(!open)}>{trigger}</button>
      {open && (
        <div className="menu picker-menu" role="dialog" aria-label={label}>
          <input autoFocus className="picker-input" placeholder={placeholder ?? `${label}…`} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} aria-label={`Filter ${label}`} />
          <div className="picker-list" role="listbox" aria-multiselectable={multi} ref={list}>
            {shown.length === 0 && <div className="picker-empty">No matches</div>}
            {shown.map((o, n) => {
              const head = o.group !== lastGroup && o.group ? <div className="menu-heading">{o.group}</div> : null
              lastGroup = o.group
              return (
                <div key={`${o.group ?? ''}/${o.value}`}>
                  {head}
                  <div role="option" className="picker-item" aria-selected={n === cursor} aria-checked={selected.includes(o.value)}
                    onMouseEnter={() => setCursor(n)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o)}>
                    {o.icon ?? (o.color ? <span className="swatch round" style={{ background: o.color }} /> : null)}
                    <span className="label">{o.label}</span>
                    {o.hint && <span className="hint">{o.hint}</span>}
                    {selected.includes(o.value) && <span className="check">✓</span>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
