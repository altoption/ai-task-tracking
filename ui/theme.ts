/**
 * Applying the chosen theme (src/engine/themes.ts) to the page: every color token becomes an inline custom property on
 * <html>, status-type overrides become `--status-<type>` (StatusIcon reads them), and `color-scheme` follows the base.
 *
 * - `effectiveTheme` and `themeVars` are pure (tested without a DOM).
 * - The last applied theme is kept in localStorage so the next load paints it before the snapshot arrives (no flash);
 *   without storage the page starts in the stylesheet's Dark and switches when the snapshot comes.
 * - `useThemeEffect` re-applies on every snapshot (the engine emits `meta` when the theme or a theme file changes) and
 *   when macOS switches between light and dark, for Match macOS.
 */
import { useEffect, useState } from 'react'
import type { Theme } from '../src/engine/themes'
import type { ThemesInfo } from './client'

const STORAGE_KEY = 'tracker.theme'
const STATUS_TYPES = ['backlog', 'unstarted', 'started', 'completed', 'canceled', 'duplicate'] as const

/** The theme to show: the chosen one, `system` resolved by the system appearance; unknown ids fall back to Dark. */
export function effectiveTheme(info: ThemesInfo | null, prefersDark: boolean): Theme | null {
  if (!info) return null
  const find = (id: string) => info.list.find((t) => t.id === id)
  let t = find(info.effective ?? info.selected) ?? find('dark')
  if (t?.base === 'system') t = find(prefersDark ? 'dark' : 'light')
  return t && t.base !== 'system' ? t : null
}

/** Custom properties for a theme: `--<token>` for every color, `--status-<type>` for each status override. */
export function themeVars(t: Theme): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(t.colors)) out[`--${k}`] = v
  for (const [k, v] of Object.entries(t.statuses)) if (v) out[`--status-${k}`] = v
  return out
}

interface Applied { base: 'dark' | 'light'; vars: Record<string, string> }

function apply(a: Applied): void {
  const root = document.documentElement
  for (const type of STATUS_TYPES) root.style.removeProperty(`--status-${type}`)
  for (const [k, v] of Object.entries(a.vars)) root.style.setProperty(k, v)
  root.style.colorScheme = a.base
  root.dataset.theme = a.base
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', a.base)
}

/** Paint the last theme this browser showed, before the first render. */
export function applyCachedTheme(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const a = raw ? (JSON.parse(raw) as Applied) : null
    if (a && (a.base === 'dark' || a.base === 'light') && a.vars && typeof a.vars === 'object') apply(a)
  } catch { /* storage blocked or bad JSON: the stylesheet's Dark until the snapshot */ }
}

const darkQuery = () => globalThis.matchMedia?.('(prefers-color-scheme: dark)')

/** Keep the page on the chosen theme. */
export function useThemeEffect(info: ThemesInfo | null): void {
  const [prefersDark, setPrefersDark] = useState(() => darkQuery()?.matches ?? true)
  useEffect(() => {
    const q = darkQuery()
    if (!q) return
    const on = (e: MediaQueryListEvent) => setPrefersDark(e.matches)
    q.addEventListener('change', on)
    return () => q.removeEventListener('change', on)
  }, [])
  useEffect(() => {
    const t = effectiveTheme(info, prefersDark)
    if (!t) return
    const a: Applied = { base: t.base, vars: themeVars(t) }
    apply(a)
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(a)) } catch { /* not remembered; fine */ }
  }, [info, prefersDark])
}
