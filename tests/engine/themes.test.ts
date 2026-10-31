import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, type ChangeEvent } from '../../src/engine/store'
import { initFolder } from '../../src/store/metaFiles'
import {
  allThemes, builtinThemes, DEFAULT_THEME, isColor, parseThemeFile, selectedTheme, THEME_TOKENS, type Theme,
} from '../../src/engine/themes'
import { DEFAULT_THEME as UI_DEFAULT_THEME } from '../../ui/theme'
import { watchFolder } from '../../src/engine/watch'
import { startServer, type RunningServer } from '../../src/server/http'
import { miniCopy } from './helpers'

// ---------- contrast (WCAG 2.x relative luminance) ----------

function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x! + 0.05) / (y! + 0.05)
}

/** `color-mix(in srgb, a p, b)` for hex colors. */
function mix(a: string, b: string, p: number): string {
  const rgb = (hex: string) => { const h = hex.replace('#', ''); const f = h.length === 3 ? [...h].map((x) => x + x).join('') : h; return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)) }
  const [x, y] = [rgb(a), rgb(b)]
  return `#${x!.map((v, i) => Math.round(v * p + y![i]! * (1 - p)).toString(16).padStart(2, '0')).join('')}`
}
const FEATURED_WARN = 0.09

const colored = builtinThemes().filter((t): t is Theme => t.base !== 'system')

describe('built-in themes', () => {
  test('the default (Graphite) is exactly the token block of ui/styles.css, and every theme sets every token', async () => {
    const css = await readFile(join(import.meta.dir, '../../ui/styles.css'), 'utf8')
    const block = /:root\s*\{([^}]*)\}/.exec(css)![1]!
    const cssColors = Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*([^;]+);/g)]
      .filter(([, k]) => !['radius', 'font', 'mono'].includes(k!)).map(([, k, v]) => [k!, v!.trim()]))
    expect(DEFAULT_THEME).toBe('graphite')
    expect(UI_DEFAULT_THEME).toBe(DEFAULT_THEME) // the UI's first-paint fallback
    expect(colored.find((t) => t.id === DEFAULT_THEME)!.colors).toEqual(cssColors)
    expect([...THEME_TOKENS]).toEqual(Object.keys(cssColors))
    for (const t of colored) {
      expect(Object.keys(t.colors).sort()).toEqual([...THEME_TOKENS].sort())
      for (const v of [...Object.values(t.colors), ...Object.values(t.statuses)]) expect(isColor(v)).toBe(true)
    }
  })

  test('the Themes guide lists every token and every built-in id', async () => {
    const guide = await readFile(join(import.meta.dir, '../../site/src/content/docs/guides/themes.md'), 'utf8')
    const listed = [...guide.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1])
    expect(listed).toEqual([...THEME_TOKENS])
    for (const t of builtinThemes()) expect(guide).toContain(`| ${t.name} | \`${t.id}\` |`)
  })

  test('picker order: Graphite (the default), Dark, Light, Match macOS, then the presets (one high-contrast)', () => {
    expect(builtinThemes().map((t) => t.id)).toEqual(['graphite', 'dark', 'light', 'system', 'midnight', 'plum', 'paper', 'high-contrast'])
    expect(builtinThemes().map((t) => t.base)).toEqual(['dark', 'dark', 'light', 'system', 'dark', 'dark', 'light', 'dark'])
  })

  // Text Home and the rest of the UI set on these backgrounds. `featured` is Home's first request card:
  // `color-mix(in srgb, var(--warn) 9%, var(--panel))` (.ov-request.featured in ui/styles.css).
  for (const t of colored) {
    test(`${t.name}: accent buttons, avatars, links and the attention color pass WCAG AA, on the featured card too`, () => {
      const c = t.colors, featured = mix(c.warn!, c.panel!, FEATURED_WARN)
      const pairs: [string, string, string][] = [
        ['on-danger', c['on-danger']!, c.danger!], ['on-accent', c['on-accent']!, c.accent!], ['on-accent', c['on-accent']!, c.avatar!], ['on-accent', c['on-accent']!, c.agent!],
        ['link', c.link!, c.panel!], ['link', c.link!, c.card!], ['warn', c.warn!, c.panel!], ['warn', c.warn!, c.card!],
        ['warn', c.warn!, featured], ['text', c.text!, featured], ['muted', c.muted!, featured], ['text', c.text!, c.active!],
      ]
      for (const [name, fg, bg] of pairs) {
        const ratio = contrast(fg, bg)
        if (ratio < 4.5) throw new Error(`${t.name}: --${name} ${fg} on ${bg} is ${ratio.toFixed(2)}:1`)
      }
    })
  }

  test('the featured card\'s mix in the test is the one in the stylesheet', async () => {
    const css = await readFile(join(import.meta.dir, '../../ui/styles.css'), 'utf8')
    expect(css).toContain(`.ov-request.featured { background: color-mix(in srgb, var(--warn) ${FEATURED_WARN * 100}%, var(--panel));`)
  })

  // WCAG AA for body text: 4.5:1. --text and --muted on both surfaces they sit on.
  for (const t of colored) {
    test(`${t.name} passes WCAG AA for --text and --muted on --bg and --panel`, () => {
      for (const fg of ['text', 'muted']) for (const bg of ['bg', 'panel']) {
        const ratio = contrast(t.colors[fg]!, t.colors[bg]!)
        if (ratio < 4.5) throw new Error(`${t.name}: --${fg} on --${bg} is ${ratio.toFixed(2)}:1`)
      }
    })
  }
})

describe('the app\'s default theme', () => {
  test('Settings uses ThemeSetting.defaultTheme, which is the engine\'s DEFAULT_THEME', async () => {
    const core = join(import.meta.dir, '../../app/Sources/TrackerCore')
    expect(await readFile(join(core, 'Settings.swift'), 'utf8')).toContain('SettingKey.theme: ThemeSetting.defaultTheme,')
    expect(await readFile(join(core, 'Theme.swift'), 'utf8')).toContain(`public static let defaultTheme = "${DEFAULT_THEME}"`)
  })
})

describe('theme files', () => {
  test('colors: hex, rgb() and hsl() pass; anything that could carry CSS does not', () => {
    for (const ok of ['#fff', '#ffff', '#a1b2c3', '#a1b2c3d4', 'rgb(1, 2, 3)', 'rgba(1,2,3,.5)', 'rgb(1 2 3 / 50%)', 'hsl(210deg 40% 50%)', 'hsla(210, 40%, 50%, 0.3)']) {
      expect(isColor(ok)).toBe(true)
    }
    for (const bad of ['red', '#ggg', '#12345', 'var(--bg)', 'url(x.png)', '#fff; } body { display: none', 'rgb(1,2,3); background: url(x)',
      'rgb(1,2,3))', 'expression(alert(1))', 'calc(1px)', '', 12, null]) {
      expect(isColor(bad)).toBe(false)
    }
  })

  test('a valid file: missing tokens come from its base, status overrides apply', () => {
    const t = parseThemeFile('name: Ocean\nbase: light\ncolors:\n  accent: "#0a84ff"\n  --bg: "#eef6ff"\nstatuses:\n  started: "#d18f00"\n', 'ocean.yml')
    const light = colored.find((x) => x.id === 'light')!
    expect(t).toMatchObject({ id: 'ocean', name: 'Ocean', base: 'light', builtin: false })
    expect(t.colors.accent).toBe('#0a84ff')
    expect(t.colors.bg).toBe('#eef6ff')
    expect(t.colors.text).toBe(light.colors.text)
    expect(t.statuses).toEqual({ ...light.statuses, started: '#d18f00' })
  })

  test('refused: unknown key, unknown token, bad base, CSS injection, non-color, built-in name, bad file name', () => {
    const bad: [string, string, RegExp][] = [
      ['name: X\nbase: dark\nextra: 1\n', 'x.yml', /unknown key extra/],
      ['name: X\nbase: dark\ncolors:\n  background-image: "#fff"\n', 'x.yml', /unknown token "background-image"/],
      ['name: X\nbase: sepia\n', 'x.yml', /base: must be dark or light/],
      ['name: X\nbase: dark\ncolors:\n  bg: "#000; } * { display: none"\n', 'x.yml', /colors\.bg: .* is not a color/],
      ['name: X\nbase: dark\ncolors:\n  bg: url(https://example.com/x.png)\n', 'x.yml', /is not a color/],
      ['name: X\nbase: dark\nstatuses:\n  doing: "#fff"\n', 'x.yml', /unknown status type "doing"/],
      ['base: dark\n', 'x.yml', /name: /],
      ['- a\n- b\n', 'x.yml', /holds name, base and colors/],
      ['name: X\nbase: dark\n', 'light.yml', /built-in theme/],
      ['name: X\nbase: dark\n', 'graphite.yml', /"graphite" is a built-in theme/],
      ['name: X\nbase: dark\n', 'plum.yml', /"plum" is a built-in theme/],
      ['name: Graphite\nbase: dark\n', 'x.yml', /built-in theme's name/],
      ['name: dark\nbase: light\n', 'x.yml', /"dark" is a built-in theme's name/],
      ['name: Match MACOS\nbase: light\n', 'x.yml', /built-in theme's name/],
      ['name: X\nbase: dark\n', 'my theme.yml', /file names use letters/],
    ]
    for (const [text, file, re] of bad) expect(() => parseThemeFile(text, file)).toThrow(re)
  })

  test('a custom theme whose name only starts like a built-in\'s (Plum Current) is fine', () => {
    expect(parseThemeFile('name: Plum Current\nbase: dark\n', 'plum-current.yml')).toMatchObject({ id: 'plum-current', name: 'Plum Current' })
  })

  test('an unknown selection falls back to the default (Graphite)', () => {
    expect(selectedTheme(allThemes([]), 'gone').id).toBe('graphite')
    expect(selectedTheme(allThemes([]), 'dark').id).toBe('dark')
    expect(selectedTheme(allThemes([]), 'system').id).toBe('system')
  })
})

describe('themes in the store, the watcher and HTTP', () => {
  let root: string, store: Store, srv: RunningServer, base: string, watcher: { close(): void }
  let events: ChangeEvent[]
  beforeEach(async () => {
    root = await miniCopy()
    await mkdir(join(root, 'themes'))
    await writeFile(join(root, 'themes', 'ocean.yml'), 'name: Ocean\nbase: light\ncolors:\n  accent: "#0a84ff"\n')
    await writeFile(join(root, 'themes', 'broken.yml'), 'name: Broken\nbase: dark\ncolors:\n  bg: "red; }"\n')
    store = await Store.open(root, { port: 0 })
    events = []
    store.on((e) => events.push(e))
    srv = startServer(store, { port: 0, version: 'test' })
    base = `http://127.0.0.1:${srv.port}`
  })
  afterEach(async () => {
    watcher?.close()
    await srv.stop()
    await Bun.sleep(50)
    await rm(root, { recursive: true, force: true })
  })
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/theme`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Tracker': '1', ...headers }, body: JSON.stringify(body) })
  const until = async (pred: () => boolean, ms = 2000) => {
    for (let t = 0; t < ms && !pred(); t += 25) await Bun.sleep(25)
    expect(pred()).toBe(true)
  }

  test('the snapshot lists built-ins and valid files; a broken file is a file error, not a theme', async () => {
    const snap = await (await fetch(`${base}/api/snapshot`)).json() as any
    // The fixture's config.yml has no theme: the default.
    expect(snap.themes.selected).toBe('graphite')
    expect(snap.themes.effective).toBe('graphite')
    expect(snap.themes.list.map((t: any) => t.id)).toEqual(['graphite', 'dark', 'light', 'system', 'midnight', 'plum', 'paper', 'high-contrast', 'ocean'])
    expect(snap.errors).toEqual([{ path: join(root, 'themes', 'broken.yml'), message: expect.stringContaining('colors.bg') }])
    const health = await (await fetch(`${base}/api/health`)).json() as any
    expect(health.theme).toMatchObject({ selected: 'graphite', effective: 'graphite' })
    expect(health.theme.themes).toContainEqual({ id: 'graphite', name: 'Graphite', base: 'dark', bg: '#141619' })
    expect(health.theme.themes).toContainEqual({ id: 'system', name: 'Match macOS', base: 'system' })
    expect(health.theme.themes).toContainEqual({ id: 'ocean', name: 'Ocean', base: 'light', bg: '#f4f4f6' })
  })

  test('POST /api/theme writes theme to config.yml and emits meta; agents and unknown ids are refused', async () => {
    expect((await post({ theme: 'light' }, { 'x-tracker-agent': '1' })).status).toBe(403)
    const unknown = await post({ theme: 'broken' })
    expect(unknown.status).toBe(400)
    expect(((await unknown.json()) as any).error).toMatch(/unknown theme "broken"/)
    expect((await post({ nope: 1 })).status).toBe(400)

    const r = await post({ theme: 'ocean' })
    expect(r.status).toBe(200)
    expect(((await r.json()) as any).selected).toBe('ocean')
    expect(events.some((e) => e.kind === 'meta')).toBe(true)
    expect(await readFile(join(root, 'config.yml'), 'utf8')).toMatch(/^theme: ocean$/m)
    expect((await Store.open(root, { port: 0 })).config.theme).toBe('ocean')
  })

  test('a saved theme is kept (Dark included); only a config.yml without theme gets the default', async () => {
    const cfg = join(root, 'config.yml')
    const text = await readFile(cfg, 'utf8')
    await writeFile(cfg, `${text}theme: dark\n`)
    expect((await Store.open(root, { port: 0 })).config.theme).toBe('dark')
    expect(selectedTheme(allThemes([]), 'dark').id).toBe('dark')
    // Picking the default over a saved Dark writes it (it differs from what the file holds).
    const s = await Store.open(root, { port: 0 })
    await s.setTheme('graphite')
    expect(await readFile(cfg, 'utf8')).toMatch(/^theme: graphite$/m)
    // A new data folder starts on the default.
    const fresh = await mkdtemp(join(tmpdir(), 'aitt-theme-'))
    try {
      await initFolder(fresh)
      expect(await readFile(join(fresh, 'config.yml'), 'utf8')).toMatch(/^theme: graphite$/m)
      expect((await Store.open(fresh, { port: 0 })).config.theme).toBe('graphite')
    } finally { await rm(fresh, { recursive: true, force: true }) }
  })

  test('custom files named like the new built-ins (graphite.yml, plum.yml) are reported and skipped; Plum Current loads', async () => {
    await writeFile(join(root, 'themes', 'graphite.yml'), 'name: My Graphite\nbase: dark\n')
    await writeFile(join(root, 'themes', 'plum.yml'), 'name: My Plum\nbase: dark\n')
    await writeFile(join(root, 'themes', 'plum-current.yml'), 'name: Plum Current\nbase: dark\ncolors:\n  bg: "#1b1320"\n')
    await writeFile(join(root, 'config.yml'), `${await readFile(join(root, 'config.yml'), 'utf8')}theme: plum-current\n`)
    const s = await Store.open(root, { port: 0 })
    expect(s.themes.map((t) => t.id)).toEqual(['ocean', 'plum-current'])
    expect(s.errors.get(join(root, 'themes', 'graphite.yml'))).toMatch(/"graphite" is a built-in theme/)
    expect(s.errors.get(join(root, 'themes', 'plum.yml'))).toMatch(/"plum" is a built-in theme/)
    expect(s.config.theme).toBe('plum-current')
    expect(selectedTheme(allThemes(s.themes), s.config.theme).id).toBe('plum-current')
  })

  test('two files with the same name (any case): the first by file name wins, the other is a file error', async () => {
    await writeFile(join(root, 'themes', 'zebra.yml'), 'name: OCEAN\nbase: dark\n')
    await writeFile(join(root, 'themes', 'aqua.yml'), 'name: Aqua\nbase: dark\n')
    const s = await Store.open(root, { port: 0 })
    expect(s.themes.map((t) => t.id)).toEqual(['aqua', 'ocean'])
    expect(s.errors.get(join(root, 'themes', 'zebra.yml'))).toMatch(/"OCEAN" is already the name of themes\/ocean\.yml/)
  })

  test('a deleted theme file: config.yml keeps the id, the snapshot and health show it as configured and the default as effective', async () => {
    await post({ theme: 'ocean' })
    await unlink(join(root, 'themes', 'ocean.yml'))
    await store.reloadFile(join(root, 'themes', 'ocean.yml'))
    const snap = await (await fetch(`${base}/api/snapshot`)).json() as any
    expect(snap.themes).toMatchObject({ selected: 'ocean', effective: 'graphite' })
    const health = await (await fetch(`${base}/api/health`)).json() as any
    expect(health.theme).toMatchObject({ selected: 'ocean', effective: 'graphite' })
    // Picking Dark explicitly writes it, so the theme doesn't jump back when the file returns.
    expect((await post({ theme: 'dark' })).status).toBe(200)
    expect(store.config.theme).toBe('dark')
  })

  test('the watcher reloads themes when the whole themes/ folder is deleted or created', async () => {
    watcher = watchFolder(store)
    await Bun.sleep(200)
    await rm(join(root, 'themes'), { recursive: true, force: true })
    await until(() => store.themes.length === 0 && ![...store.errors.keys()].some((p) => p.includes('/themes/')))
    await mkdir(join(root, 'themes-new'))
    await writeFile(join(root, 'themes-new', 'mint.yml'), 'name: Mint\nbase: light\n')
    const { rename } = await import('node:fs/promises')
    await rename(join(root, 'themes-new'), join(root, 'themes'))
    await until(() => store.themes.some((t) => t.id === 'mint'))
  })

  test('the watcher picks up a new, fixed or removed theme file', async () => {
    watcher = watchFolder(store)
    await Bun.sleep(200)
    await writeFile(join(root, 'themes', 'broken.yml'), 'name: Fixed\nbase: dark\ncolors:\n  bg: "#000000"\n')
    await until(() => store.themes.some((t) => t.id === 'broken') && !store.errors.has(join(root, 'themes', 'broken.yml')))
    expect(events.some((e) => e.kind === 'meta')).toBe(true)
    await writeFile(join(root, 'themes', 'mint.yml'), 'name: Mint\nbase: light\ncolors:\n  nope: "#fff"\n')
    await until(() => store.errors.has(join(root, 'themes', 'mint.yml')))
    expect(events.some((e) => e.kind === 'error' && e.path.endsWith('mint.yml'))).toBe(true)
    await unlink(join(root, 'themes', 'ocean.yml'))
    await until(() => !store.themes.some((t) => t.id === 'ocean'))
  })
})
