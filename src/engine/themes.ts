/**
 * Themes: the values of the UI's color tokens (the `:root` block of ui/styles.css), chosen with `theme` in config.yml.
 *
 * - Built-ins: Graphite (the default when config.yml has no `theme`, and the look of ui/styles.css), Dark, Light, Match
 *   macOS (`system`: Dark or Light, following the system appearance; the UI and the app resolve it), and the presets
 *   Midnight, Plum, Paper and High contrast. Dark and Light are also the two bases every other theme builds on.
 * - Custom themes: `themes/<id>.yml` in the data folder: `name`, `base: dark|light`, `colors: {token: color}` and an
 *   optional `statuses: {statusType: color}`. A token left out takes its base's value. Only known token names and
 *   status types are accepted, and every value must be a color (hex, rgb() or hsl()), so a file can't inject CSS.
 *   A file that breaks a rule is a file error (shown in the UI) and is skipped.
 *
 * Pure: parsing and resolving only; the store reads the files and the server sends the result.
 */
import YAML from 'yaml'
import type { StatusDef } from '../model'

export type StatusType = StatusDef['type']
export type ThemeBase = 'dark' | 'light'
/** A theme as sent to clients: every token resolved (`colors` is complete), plus per-status-type overrides. */
export interface Theme {
  id: string; name: string; base: ThemeBase; builtin: boolean
  colors: Record<string, string>
  statuses: Partial<Record<StatusType, string>>
}
/** `system` (Match macOS) has no colors of its own: clients show `dark` or `light` by the system appearance. */
export type ThemeOut = Theme | { id: typeof SYSTEM_THEME; name: string; base: 'system'; builtin: true }

/** The theme shown when config.yml has no `theme` (or names a theme that no longer exists). */
export const DEFAULT_THEME = 'graphite'
export const SYSTEM_THEME = 'system'
export const STATUS_TYPES: readonly StatusType[] = ['backlog', 'unstarted', 'started', 'completed', 'canceled', 'duplicate']

/** The Dark theme, and the base of every dark theme: a token a dark theme leaves out takes this value. */
const DARK: Record<string, string> = {
  bg: '#101012', panel: '#17171b', hover: '#1c1c21', active: '#22222a', card: '#1c1c21', 'card-hover': '#202026',
  'group-bg': '#1b1b20', lane: 'rgba(255, 255, 255, .012)', 'code-bg': '#1f1f25', 'pre-bg': '#1a1a1f',
  border: '#26262c', divider: 'rgba(38, 38, 44, .5)', 'pill-border': '#2c2c33', 'border-focus': '#3a3a44',
  text: '#d8d8dc', 'text-strong': '#fff', muted: '#8a8a93', faint: '#5f5f68', id: '#6e6e78', 'pill-text': '#a0a0aa',
  link: '#9c9cf4', 'on-accent': '#fff',
  accent: '#7161ea', 'accent-wash': 'rgba(113, 97, 234, .06)', warn: '#c9a227', danger: '#e5534b',
  'danger-border': 'rgba(229, 83, 75, .45)', 'danger-border-soft': 'rgba(229, 83, 75, .4)', ok: '#3fb950',
  'ok-border': 'rgba(63, 185, 80, .45)', merged: '#a371f7', 'merged-border': 'rgba(163, 113, 247, .45)',
  'in-progress': '#e3b341', urgent: '#f2994a', star: '#f2c94c', avatar: '#5e6ad2', agent: '#2f6f4f',
  'switch-off': '#3a3a44', 'switch-off-hover': '#45454f', 'switch-knob': '#e8e8ec',
  shadow: 'rgba(0, 0, 0, .5)', 'shadow-strong': 'rgba(0, 0, 0, .6)', overlay: 'rgba(0, 0, 0, .45)', 'tile-shadow': 'rgba(0, 0, 0, .4)',
}

/** Every token a theme may set, in the order of ui/styles.css (whose `:root` is the default theme, Graphite). */
export const THEME_TOKENS: readonly string[] = Object.keys(DARK)

const LIGHT: Record<string, string> = {
  bg: '#f4f4f6', panel: '#ffffff', hover: '#ececf0', active: '#e4e4ea', card: '#fafafb', 'card-hover': '#f2f2f5',
  'group-bg': '#f0f0f3', lane: 'rgba(0, 0, 0, .02)', 'code-bg': '#f0f0f3', 'pre-bg': '#f5f5f7',
  border: '#e2e2e7', divider: 'rgba(226, 226, 231, .7)', 'pill-border': '#d9d9df', 'border-focus': '#b8b8c2',
  text: '#1d1d22', 'text-strong': '#000', muted: '#5f5f6b', faint: '#9a9aa4', id: '#74747e', 'pill-text': '#4d4d57',
  link: '#5b4fd6', 'on-accent': '#fff',
  accent: '#6c5ce7', 'accent-wash': 'rgba(108, 92, 231, .08)', warn: '#8f6100', danger: '#cf3a32',
  'danger-border': 'rgba(207, 58, 50, .45)', 'danger-border-soft': 'rgba(207, 58, 50, .4)', ok: '#1f883d',
  'ok-border': 'rgba(31, 136, 61, .45)', merged: '#8250df', 'merged-border': 'rgba(130, 80, 223, .45)',
  'in-progress': '#c98f00', urgent: '#e8792b', star: '#e0a800', avatar: '#5e6ad2', agent: '#2f7d55',
  'switch-off': '#c9c9d1', 'switch-off-hover': '#b9b9c3', 'switch-knob': '#ffffff',
  shadow: 'rgba(0, 0, 0, .14)', 'shadow-strong': 'rgba(0, 0, 0, .2)', overlay: 'rgba(0, 0, 0, .25)', 'tile-shadow': 'rgba(0, 0, 0, .25)',
}
/** The default Todo and Backlog colors are too pale on a light background. */
const LIGHT_STATUSES: Theme['statuses'] = { backlog: '#a1a6ae', unstarted: '#8a9099' }

interface Preset { id: string; name: string; base: ThemeBase; colors: Record<string, string>; statuses?: Theme['statuses'] }
const PRESETS: Preset[] = [
  {
    // The default (DEFAULT_THEME): calm graphite surfaces with a sage accent; ui/styles.css `:root` is exactly this.
    id: 'graphite', name: 'Graphite', base: 'dark',
    colors: {
      bg: '#141619', panel: '#181a1d', hover: '#1f2124', active: '#293830', card: '#202226', 'card-hover': '#25272b',
      'group-bg': '#1d1f22', 'code-bg': '#222428', 'pre-bg': '#1c1e21', border: '#34383b', divider: 'rgba(52, 56, 59, .55)',
      'pill-border': '#3b3f42', 'border-focus': '#4b5053', text: '#ebece8', muted: '#a1a7a4', faint: '#737976', id: '#8c928f',
      'pill-text': '#b5bab7', link: '#a9d3bc', 'on-accent': '#17261e', accent: '#99c6ad', 'accent-wash': 'rgba(153, 198, 173, .07)',
      warn: '#d5b477', avatar: '#a8b4e6', agent: '#86c7a3', 'switch-off': '#3b3f42', 'switch-off-hover': '#474c50', 'switch-knob': '#ebece8',
    },
  },
  {
    id: 'midnight', name: 'Midnight', base: 'dark',
    colors: {
      bg: '#0d1117', panel: '#131a24', hover: '#1a2330', active: '#212c3b', card: '#18212d', 'card-hover': '#1d2836',
      'group-bg': '#16202b', 'code-bg': '#1b2532', 'pre-bg': '#161f2a', border: '#243041', divider: 'rgba(36, 48, 65, .6)',
      'pill-border': '#2a384b', 'border-focus': '#3a4a60', text: '#d6deeb', muted: '#8b98ab', faint: '#5c6a7e', id: '#6f7d91',
      'pill-text': '#a3b0c2', accent: '#7aa2f7', 'accent-wash': 'rgba(122, 162, 247, .07)', link: '#8fb3ff', 'on-accent': '#10131c', avatar: '#a3b1f5', agent: '#7fcfa3',
      'switch-off': '#33425a', 'switch-off-hover': '#3d4e69',
    },
  },
  {
    id: 'plum', name: 'Plum', base: 'dark',
    colors: {
      bg: '#1e1623', panel: '#251b2a', hover: '#2c2131', active: '#413047', card: '#2e2233', 'card-hover': '#34273a',
      'group-bg': '#2a1f2f', 'code-bg': '#312537', 'pre-bg': '#2a1f2f', border: '#45354b', divider: 'rgba(69, 53, 75, .55)',
      'pill-border': '#4d3c54', 'border-focus': '#604c68', text: '#eee6f0', muted: '#baadbf', faint: '#85778b', id: '#9d90a2',
      'pill-text': '#cbbfd0', link: '#d6b9e2', 'on-accent': '#291b31', accent: '#caa7d8', 'accent-wash': 'rgba(202, 167, 216, .07)',
      warn: '#d8b87e', avatar: '#b3b8ee', agent: '#8fcba8', 'switch-off': '#4d3c54', 'switch-off-hover': '#5a4762', 'switch-knob': '#eee6f0',
    },
  },
  {
    id: 'paper', name: 'Paper', base: 'light',
    colors: {
      bg: '#efeee8', panel: '#f8f7f3', hover: '#e9e8e1', active: '#e5eade', card: '#ffffff', 'card-hover': '#f4f3ee',
      'group-bg': '#f2f1ec', 'code-bg': '#ecebe4', 'pre-bg': '#f3f2ec', border: '#dddcd4', divider: 'rgba(221, 220, 212, .7)',
      'pill-border': '#d2d1c8', 'border-focus': '#b0afa5', text: '#2c302c', 'text-strong': '#161916', muted: '#5f665e',
      faint: '#9a9e98', id: '#737872', 'pill-text': '#4f554e', link: '#3d5c43', accent: '#46664c',
      'accent-wash': 'rgba(70, 102, 76, .08)', warn: '#83621f', 'switch-off': '#d2d1c8', 'switch-off-hover': '#c3c2b8',
    },
  },
  {
    id: 'high-contrast', name: 'High contrast', base: 'dark',
    colors: {
      bg: '#000000', panel: '#0a0a0a', hover: '#1a1a1f', active: '#26262e', card: '#111114', 'card-hover': '#1a1a1f',
      'group-bg': '#141418', border: '#5a5a64', divider: 'rgba(90, 90, 100, .7)', 'pill-border': '#6a6a74',
      'border-focus': '#9a9aa6', text: '#ffffff', muted: '#c8c8d0', faint: '#9a9aa4', id: '#b4b4bc', 'pill-text': '#e0e0e6',
      accent: '#a99bff', link: '#b8adff', 'on-accent': '#14121f', avatar: '#a3b1f5', agent: '#7fcfa3', 'switch-off': '#55555f', 'switch-off-hover': '#66666f',
    },
    statuses: { backlog: '#d0d4da', canceled: '#b8c2cf', duplicate: '#b8c2cf' },
  },
]

const BASES: Record<ThemeBase, { colors: Record<string, string>; statuses: Theme['statuses'] }> = {
  dark: { colors: DARK, statuses: {} },
  light: { colors: LIGHT, statuses: LIGHT_STATUSES },
}

/** A theme from a base plus the tokens and status colors it sets (the rest come from the base). */
function resolve(id: string, name: string, base: ThemeBase, builtin: boolean, colors: Record<string, string>, statuses: Theme['statuses'] = {}): Theme {
  return { id, name, base, builtin, colors: { ...BASES[base].colors, ...colors }, statuses: { ...BASES[base].statuses, ...statuses } }
}

/** The built-in themes, in picker order: Graphite (the default), Dark, Light, Match macOS, then the other presets. */
export function builtinThemes(): ThemeOut[] {
  const preset = (p: Preset) => resolve(p.id, p.name, p.base, true, p.colors, p.statuses)
  return [
    ...PRESETS.filter((p) => p.id === DEFAULT_THEME).map(preset),
    resolve('dark', 'Dark', 'dark', true, {}),
    resolve('light', 'Light', 'light', true, {}),
    { id: SYSTEM_THEME, name: 'Match macOS', base: 'system', builtin: true },
    ...PRESETS.filter((p) => p.id !== DEFAULT_THEME).map(preset),
  ]
}

const BUILTIN_IDS = new Set(builtinThemes().map((t) => t.id))
const BUILTIN_NAMES = new Set(builtinThemes().map((t) => t.name.toLowerCase()))

// ---------- custom theme files ----------

const NUM = String.raw`(?:\d+(?:\.\d+)?|\.\d+)`
const SEP = String.raw`(?:\s*,\s*|\s+)`
const ALPHA = String.raw`(?:\s*[,/]\s*${NUM}%?)?`
const COLOR_RES = [
  /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i,
  new RegExp(String.raw`^rgba?\(\s*${NUM}%?${SEP}${NUM}%?${SEP}${NUM}%?${ALPHA}\s*\)$`, 'i'),
  new RegExp(String.raw`^hsla?\(\s*${NUM}(?:deg)?${SEP}${NUM}%${SEP}${NUM}%${ALPHA}\s*\)$`, 'i'),
]

/** A CSS color in one of the accepted forms: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()`, `hsl()`/`hsla()`. */
export function isColor(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 64 && COLOR_RES.some((re) => re.test(v.trim()))
}

/** The theme id of a `themes/` file name: its name without `.yml`; letters, digits, `-` and `_` only. */
export function themeIdOf(fileName: string): string | null {
  const m = /^([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.yml$/.exec(fileName)
  return m ? m[1]! : null
}

const FILE_KEYS = ['name', 'base', 'colors', 'statuses']

/** Parse and check one `themes/<id>.yml`. Throws an Error that says what to fix (the store shows it as a file error). */
export function parseThemeFile(text: string, fileName: string): Theme {
  const id = themeIdOf(fileName)
  if (!id) throw new Error('theme file names use letters, digits, "-" and "_" only, ending in .yml (themes/ocean.yml)')
  if (BUILTIN_IDS.has(id)) throw new Error(`"${id}" is a built-in theme; give the file another name`)
  const raw = YAML.parse(text.replace(/\r\n/g, '\n')) as unknown
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('a theme file holds name, base and colors')
  const o = raw as Record<string, unknown>
  const unknown = Object.keys(o).filter((k) => !FILE_KEYS.includes(k))
  if (unknown.length) throw new Error(`unknown key${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} (allowed: ${FILE_KEYS.join(', ')})`)
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  if (!name || name.length > 40) throw new Error('name: a name of 1 to 40 characters is required')
  if (BUILTIN_NAMES.has(name.toLowerCase())) throw new Error(`name: "${name}" is a built-in theme's name; pick another`)
  if (o.base !== 'dark' && o.base !== 'light') throw new Error('base: must be dark or light')
  const colors = checkMap(o.colors, 'colors', new Set(THEME_TOKENS), 'token')
  const statuses = checkMap(o.statuses, 'statuses', new Set(STATUS_TYPES), 'status type')
  return resolve(id, name, o.base, false, colors, statuses)
}

function checkMap(v: unknown, key: string, allowed: Set<string>, what: string): Record<string, string> {
  if (v === undefined || v === null) return {}
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`${key}: a map of ${what} → color`)
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const name = k.replace(/^--/, '')
    if (!allowed.has(name)) throw new Error(`${key}: unknown ${what} "${k}" (allowed: ${[...allowed].join(', ')})`)
    if (!isColor(val)) throw new Error(`${key}.${k}: "${String(val)}" is not a color (use #rrggbb, rgb(…) or hsl(…))`)
    out[name] = val.trim()
  }
  return out
}

/** Built-ins then custom themes (by name); a custom theme never replaces a built-in. */
export function allThemes(custom: Theme[]): ThemeOut[] {
  return [...builtinThemes(), ...[...custom].sort((a, b) => a.name.localeCompare(b.name))]
}

/** The theme to show for `selected` (`system` stays `system`); an unknown id (a deleted file) falls back to the default. */
export function selectedTheme(list: ThemeOut[], selected: string): ThemeOut {
  return list.find((t) => t.id === selected) ?? list.find((t) => t.id === DEFAULT_THEME)!
}
