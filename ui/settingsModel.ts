/**
 * The Settings page's content (`#/settings`, ui/views/Settings.tsx), pure so tests and the docs generator
 * (scripts/gen-docs-reference.ts) read the same rows the page shows.
 *
 * Two kinds of setting, by where the value is stored:
 * - Engine settings live in config.yml, so they work in the app and in a browser (ENGINE_SETTINGS).
 * - App settings live in the app's UserDefaults (or macOS, for Launch at login). The engine can't read them, so only
 *   the app's web view has controls, through the bridge (ui/appSettings.ts, SettingsBridgeHandler in the app);
 *   a browser says "Only in the app". APP_GROUPS' keys must match SettingsBridge.boolKeys and presetKeys (a test checks).
 */
export const SETTINGS_TABS = [
  { id: 'general', name: 'General' },
  { id: 'appearance', name: 'Appearance' },
  { id: 'notifications', name: 'Notifications' },
  { id: 'projects', name: 'Projects' },
  { id: 'shortcuts', name: 'Shortcuts' },
  { id: 'backup', name: 'Backup' },
] as const
export type SettingsTab = (typeof SETTINGS_TABS)[number]['id']

export const isSettingsTab = (s: string): s is SettingsTab => SETTINGS_TABS.some((t) => t.id === s)

/** Launch at login isn't a UserDefaults key: the bridge asks macOS. */
export const LOGIN_KEY = 'launchAtLogin'

export type AppRow =
  /** `needs`: not changeable while that switch is off. */
  | { kind: 'switch'; key: string; label: string; desc?: string; needs?: string }
  | { kind: 'select'; key: string; label: string; desc?: string }
  | { kind: 'backupNow'; label: string; desc: string; action: string }
  /** Plain information, the same everywhere. */
  | { kind: 'note'; label: string; desc: string }

export interface AppGroup { title: string; rows: AppRow[] }

/** The app-only rows of each tab, in order. Appearance and Projects show their engine settings instead. */
export const APP_GROUPS: Record<SettingsTab, AppGroup[]> = {
  general: [
    {
      title: 'Startup',
      rows: [
        { kind: 'switch', key: LOGIN_KEY, label: 'Launch at login', desc: 'Start AI Task Tracking when you log in to this Mac.' },
        { kind: 'switch', key: 'showInDock', label: 'Show in the Dock', desc: 'Off keeps it in the menu bar only.' },
      ],
    },
    {
      title: 'Needs you',
      rows: [
        { kind: 'switch', key: 'showNeedsYouInMenu', label: 'Show Needs-you issues in the menu', desc: 'List what is waiting on you in the menu bar.' },
        {
          kind: 'switch', key: 'showStalledInNeedsYou', label: 'Show stalled work in Needs you',
          desc: 'Idle in In Progress, or reopened again and again. When off, the menu-bar number, the menu and notifications leave it out; Home still marks it.',
        },
        {
          kind: 'switch', key: 'showCIStatus', label: 'Show CI status',
          desc: 'Checks of linked GitHub PRs, fetched in the background with your gh. When off, the engine stops running gh: no badges, and failing checks don\'t join Needs you.',
        },
      ],
    },
  ],
  appearance: [],
  notifications: [
    {
      title: 'Agent activity',
      rows: [
        { kind: 'switch', key: 'notifications', label: 'Notify me about agent activity', desc: 'macOS notifications for the events below.' },
        { kind: 'switch', key: 'notifyNeedsYou', label: 'An agent needs me', desc: 'Waiting, Needs decision, Needs review or stalled.', needs: 'notifications' },
        { kind: 'switch', key: 'notifyDone', label: 'An agent finished an issue', desc: 'It moved to Done.', needs: 'notifications' },
        { kind: 'switch', key: 'notifyNew', label: 'An agent created an issue', needs: 'notifications' },
      ],
    },
  ],
  projects: [],
  shortcuts: [
    {
      title: 'Global shortcuts',
      rows: [
        { kind: 'switch', key: 'openWindowHotKey', label: 'Open AI Task Tracking window', desc: 'From anywhere on this Mac.' },
        { kind: 'select', key: 'openWindowHotKeyPreset', label: 'Shortcut to open' },
        { kind: 'switch', key: 'quickCaptureHotKey', label: 'Quick capture', desc: 'Add an issue without leaving what you are doing.' },
        { kind: 'select', key: 'quickCaptureHotKeyPreset', label: 'Shortcut to capture' },
      ],
    },
    {
      title: 'In the window',
      rows: [{ kind: 'note', label: 'Back and forward', desc: 'Back ⌘[ · Forward ⌘] · mouse side buttons · two-finger swipe.' }],
    },
  ],
  backup: [
    {
      title: 'GitHub backup',
      rows: [
        { kind: 'switch', key: 'backupBeforeQuit', label: 'Back up to GitHub before quitting', desc: 'When off, quitting still commits your changes; it just doesn\'t wait for the push.' },
        { kind: 'backupNow', label: 'Back up now', desc: 'Commit and push the data folder now.', action: 'Back up now' },
      ],
    },
  ],
}

/** Pure: the tab an arrow key, Home or End moves to; null for any other key. Wraps around. */
export function nextSettingsTab(current: SettingsTab, key: string): SettingsTab | null {
  const n = SETTINGS_TABS.length
  const i = SETTINGS_TABS.findIndex((t) => t.id === current)
  const to = key === 'ArrowRight' ? (i + 1) % n : key === 'ArrowLeft' ? (i - 1 + n) % n : key === 'Home' ? 0 : key === 'End' ? n - 1 : -1
  return to < 0 ? null : SETTINGS_TABS[to]!.id
}

// ---------- the General tab's status strip (only what /api/health and the feed can truthfully say) ----------

export type Tone = 'ok' | 'warn' | 'danger' | 'off'
export interface StatusLine { text: string; tone: Tone }

/** /api/health, as far as the status strip reads it. */
export interface HealthInfo {
  home?: string
  git?: { lastPush?: string; pushError?: string; commitError?: string; pending?: boolean; ahead?: number; remote?: boolean }
}

/** "just now", "3 min ago", "2 h ago", "yesterday", "4 days ago" (BackupText.relative in the app says the same). */
export function relativeAge(at: string, now: number): string {
  const s = Math.max(0, (now - Date.parse(at)) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`
  if (s < 172_800) return 'yesterday'
  return `${Math.floor(s / 86_400)} days ago`
}

export function engineStatus(health: HealthInfo | null, connected: boolean): StatusLine {
  if (!health || !connected) return { text: 'Not reachable', tone: 'danger' }
  return { text: health.home ? `Running · data in ${health.home}` : 'Running', tone: 'ok' }
}

/** The app menu's backup line (BackupText.line). */
export function backupStatus(health: HealthInfo | null, now: number): StatusLine {
  const g = health?.git
  if (!g) return { text: 'Status unavailable', tone: 'off' }
  if (g.commitError) return { text: 'Can\'t commit your changes', tone: 'danger' }
  if (g.pushError) return { text: 'Backup error', tone: 'danger' }
  if (!g.remote) return { text: 'No GitHub backup (no remote)', tone: 'off' }
  if (g.lastPush) return { text: `Last backed up ${relativeAge(g.lastPush, now)}`, tone: 'ok' }
  if (!g.ahead && !g.pending) return { text: 'Backed up', tone: 'ok' }
  return { text: 'Not backed up yet', tone: 'warn' }
}

/**
 * The engine doesn't know which agents are connected (each tool starts its own MCP proxy), so this says only what it
 * does know: the last agent write it recorded. `feed` is newest first.
 */
export function agentStatus(feed: readonly { at: string; actor: { actor: string; client?: string } }[], now: number): StatusLine {
  const last = feed.find((e) => e.actor.actor === 'agent')
  if (!last) return { text: 'No agent activity yet', tone: 'off' }
  return { text: `Last write ${relativeAge(last.at, now)}${last.actor.client ? ` · ${last.actor.client}` : ''}`, tone: 'ok' }
}
