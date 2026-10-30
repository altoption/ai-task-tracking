import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const UI = join(import.meta.dir, '../../ui')
const COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g

/** Every color the UI uses is a token on `:root` in ui/styles.css, so a theme can replace all of them. */
describe('UI colors are tokens', () => {
  test('styles.css names colors only in its :root token block', () => {
    const css = readFileSync(join(UI, 'styles.css'), 'utf8')
    const root = /:root\s*\{[^}]*\}/.exec(css)
    expect(root).not.toBeNull()
    const rest = css.replace(root![0], '')
    expect(rest.match(COLOR) ?? []).toEqual([])
  })

  test('components and views name no colors', () => {
    const files = ['components', 'views', '.'].flatMap((d) =>
      readdirSync(join(UI, d)).filter((f) => /\.tsx?$/.test(f)).map((f) => join(UI, d, f)))
    const found = files.flatMap((f) => (readFileSync(f, 'utf8').match(COLOR) ?? []).map((m) => `${f}: ${m}`))
    expect(found).toEqual([])
  })

  test('every token the UI uses is defined', () => {
    const css = readFileSync(join(UI, 'styles.css'), 'utf8')
    const root = /:root\s*\{([^}]*)\}/.exec(css)![1]!
    const defined = new Set([...root.matchAll(/(--[a-z-]+):/g)].map((m) => m[1]))
    const local = new Set([...css.matchAll(/(--[a-z-]+):/g)].map((m) => m[1])) // e.g. --sidebar-w on .app
    const sources = [css, ...['components', 'views'].flatMap((d) => readdirSync(join(UI, d)).map((f) => readFileSync(join(UI, d, f), 'utf8')))]
    const used = new Set(sources.flatMap((s) => [...s.matchAll(/var\((--[a-z-]+)/g)].map((m) => m[1]!)))
    expect([...used].filter((v) => !defined.has(v) && !local.has(v))).toEqual([])
  })
})
