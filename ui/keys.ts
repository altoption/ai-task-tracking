/** Global single-key shortcuts: `c` new issue, `/` search, `g h` home, `g i` all issues. ⌘K is handled separately. */
export type KeyAction = 'new' | 'search' | 'home' | 'issues'
export interface KeyState { pendingG: number | null } // time `g` was pressed
export const CHORD_MS = 1000

/** Pure: the action (if any) for a key press, and the next chord state. */
export function keyAction(s: KeyState, key: string, now: number): { action: KeyAction | null; next: KeyState } {
  const k = key.toLowerCase()
  if (s.pendingG !== null && now - s.pendingG <= CHORD_MS) {
    if (k === 'h') return { action: 'home', next: { pendingG: null } }
    if (k === 'i') return { action: 'issues', next: { pendingG: null } }
  }
  if (k === 'g') return { action: null, next: { pendingG: now } }
  if (k === 'c') return { action: 'new', next: { pendingG: null } }
  if (key === '/') return { action: 'search', next: { pendingG: null } }
  return { action: null, next: { pendingG: null } }
}

/** Typing in a field, or a modified key: shortcuts don't apply. */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!t || typeof (t as HTMLElement).tagName !== 'string') return false
  const el = t as HTMLElement
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)
}
