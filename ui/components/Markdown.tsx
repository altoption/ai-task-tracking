import { useMemo, type MouseEvent } from 'react'
import { makeSanitizer, renderMarkdown, type MdContext } from '../markdown'

// The only place HTML built from issue data enters the DOM: marked → DOMPurify (URL allow-list, no scripts/handlers).
const sanitize = makeSanitizer(window)

/** Rendered, sanitized markdown. `onToggleTask(n)` makes task checkboxes clickable (n = document order). */
export function Markdown({ source, ctx, onToggleTask, className }: {
  source: string; ctx: MdContext; onToggleTask?: (index: number) => void; className?: string
}) {
  const keys = ctx.keys ? [...ctx.keys].join(',') : ''
  const html = useMemo(() => sanitize(renderMarkdown(source, ctx)), [source, ctx.project, keys])
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement
    if (!(t instanceof HTMLInputElement) || !t.classList.contains('task')) return
    e.preventDefault() // the checkbox flips when the saved markdown re-renders
    if (!onToggleTask) return
    onToggleTask([...e.currentTarget.querySelectorAll('input.task')].indexOf(t))
  }
  return <div className={`markdown ${className ?? ''}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
}
