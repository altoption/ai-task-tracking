import { describe, expect, test } from 'bun:test'
import { appLink, httpLink, openCommand, parseOpenTarget } from '../../src/cli/open'

describe('parseOpenTarget', () => {
  test.each([
    ['ATT-1', { kind: 'issue', id: 'ATT-1' }],
    ['att-12', { kind: 'issue', id: 'ATT-12' }],
    ['2FA-3', { kind: 'issue', id: '2FA-3' }],
    ['website', { kind: 'project', slug: 'website' }],
    ['web-app', { kind: 'project', slug: 'web-app' }],
    ['project/phase-2', { kind: 'project', slug: 'phase-2' }],
    ['aitt://issue/att-7', { kind: 'issue', id: 'ATT-7' }],
    ['aitt://project/web-app', { kind: 'project', slug: 'web-app' }],
    ['aitt://new', { kind: 'new' }],
    ['http://127.0.0.1:7477/#/issue/ATT-1', { kind: 'issue', id: 'ATT-1', port: 7477 }],
    ['http://localhost:9000/#/project/website?group=status', { kind: 'project', slug: 'website', port: 9000 }],
  ])('%s', (input, want) => expect(parseOpenTarget(input as string)).toEqual(want as any))

  test.each([
    ['', /issue id/], ['ATT-', /issue id/], ['Web App', /issue id/], ['att-1; rm -rf ~', /issue id/],
    ['https://example.com/#/issue/ATT-1', /AI Task Tracking link/], ['aitt://issue/', /AI Task Tracking link/],
    ['http://127.0.0.1:7477/#/search?q=x', /AI Task Tracking link/], ['other://issue/ATT-1', /AI Task Tracking link/],
  ])('rejects %p', (input, msg) => expect(() => parseOpenTarget(input as string)).toThrow(msg as RegExp))
})

describe('links', () => {
  test('app links use the aitt:// scheme the app registers', () => {
    expect(appLink({ kind: 'issue', id: 'ATT-1' })).toBe('aitt://issue/ATT-1')
    expect(appLink({ kind: 'project', slug: 'web-app' })).toBe('aitt://project/web-app')
    expect(appLink({ kind: 'new' })).toBe('aitt://new')
  })
  test('http links match the tool results\' url and the UI router', () => {
    expect(httpLink({ kind: 'issue', id: 'ATT-1' }, 7477)).toBe('http://127.0.0.1:7477/#/issue/ATT-1')
    expect(httpLink({ kind: 'project', slug: 'web-app' }, 7478)).toBe('http://127.0.0.1:7478/#/project/web-app')
    expect(httpLink({ kind: 'new' }, 7477)).toBe('http://127.0.0.1:7477/#/new')
  })
})

describe('openCommand', () => {
  const harness = (codes: Record<string, number>) => {
    const opened: string[] = [], out: string[] = []
    const deps = {
      open: async (url: string) => { opened.push(url); return codes[url.split(':')[0]!] ?? 0 },
      port: async () => 7477,
      log: (l: string) => out.push(l),
    }
    return { opened, out, deps }
  }
  test('opens the app link', async () => {
    const h = harness({})
    expect(await openCommand(['ATT-1'], h.deps)).toBe(0)
    expect(h.opened).toEqual(['aitt://issue/ATT-1'])
  })
  test('app not installed (open fails) -> the http link in the browser, on the configured port', async () => {
    const h = harness({ aitt: 1 })
    expect(await openCommand(['web-app'], h.deps)).toBe(0)
    expect(h.opened).toEqual(['aitt://project/web-app', 'http://127.0.0.1:7477/#/project/web-app'])
  })
  test('an http link keeps its own port for the fallback', async () => {
    const h = harness({ aitt: 1 })
    await openCommand(['http://127.0.0.1:9000/#/issue/ATT-2'], h.deps)
    expect(h.opened[1]).toBe('http://127.0.0.1:9000/#/issue/ATT-2')
  })
  test('both fail -> exit 1 with a message', async () => {
    const h = harness({ aitt: 1, http: 1 })
    expect(await openCommand(['ATT-1'], h.deps)).toBe(1)
    expect(h.out.join('\n')).toMatch(/Could not open/)
  })
  test('bad or missing argument -> exit 2 with usage, nothing opened', async () => {
    for (const args of [[], ['nope nope'], ['ATT-1', 'extra']]) {
      const h = harness({})
      expect(await openCommand(args, h.deps)).toBe(2)
      expect(h.opened).toEqual([])
      expect(h.out.join('\n')).toMatch(/Usage: aitt open/)
    }
  })
})
