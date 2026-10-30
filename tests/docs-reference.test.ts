import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { check, HOTKEY_SWIFT, parseOptions, parseSettings, SETTINGS_SWIFT, typeName, WINDOW_SWIFT } from '../scripts/gen-docs-reference'

const ROOT = join(import.meta.dir, '..')
const read = (p: string) => readFile(join(ROOT, p), 'utf8')

/** The docs site's reference pages are generated from source; a change to a usage text, a tool, a setting or a
 * config default must come with `bun run docs:gen`. */
describe('docs reference pages', () => {
  test('the committed pages match what the generator writes', async () => {
    const diffs = await check()
    if (diffs.length) console.error(`Run \`bun run docs:gen\`:\n  ${diffs.join('\n  ')}`)
    expect(diffs).toEqual([])
  })

  test('option lines parse with one or more spaces, and continuation lines join', () => {
    const usage = 'Usage: x\n  --yes, -y        no questions\n  --connect <tools> connect tools,\n                    comma-separated\n  AITT_HOME=<dir>  data folder\nNot an option'
    expect(parseOptions(usage, 'flag')).toEqual([
      { names: '--yes, -y', text: 'no questions' },
      { names: '--connect <tools>', text: 'connect tools, comma-separated' },
    ])
    expect(parseOptions(usage, 'env')).toEqual([{ names: 'AITT_HOME=<dir>', text: 'data folder' }])
  })

  test('schema constraints are shown; a keyword the generator does not know is an error, not a dropped constraint', () => {
    expect(typeName({ type: 'integer', minimum: 0, maximum: 4 }, 'x')).toBe('integer (≥ 0, ≤ 4)')
    expect(typeName({ type: 'string', minLength: 2, maxLength: 9, default: 'a' }, 'x')).toBe('string (length ≥ 2, length ≤ 9, default `"a"`)')
    expect(() => typeName({ type: 'object', additionalProperties: false }, 'tool.arg')).toThrow('additionalProperties')
    expect(() => typeName({ type: 'string', format: 'date' }, 'tool.arg')).toThrow('format')
  })

  test('Settings: a preset, default or key the parser cannot read fails instead of being skipped', async () => {
    const [core, win, hot] = await Promise.all([read(SETTINGS_SWIFT), read(WINDOW_SWIFT), read(HOTKEY_SWIFT)])
    expect(parseSettings(core, win, hot).length).toBeGreaterThan(5)
    const odd = hot.replace('label: "⌥⌘T"', 'title: "⌥⌘T"')
    expect(odd).not.toBe(hot)
    expect(() => parseSettings(core, win, odd)).toThrow("can't read the preset")
    expect(() => parseSettings(core.replace('SettingKey.notifyNew: false,', 'SettingKey.notifyNew: false'), win, hot)).toThrow("can't read the default")
    expect(() => parseSettings(core.replace('SettingKey.showInDock: true,', ''), win, hot)).toThrow('no boolean default')
  })
})
