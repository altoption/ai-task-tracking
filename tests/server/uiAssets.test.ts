import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { Store } from '../../src/engine/store'
import { startServer, type RunningServer } from '../../src/server/http'
import { embeddedUi, uiAssetMap } from '../../src/server/uiAssets'
import { miniCopy } from '../engine/helpers'

// What `bun build --compile --asset ui/dist` puts in Bun.embeddedFiles: Blobs named by build-relative path.
const files = [
  new File(['<!doctype html><title>Tracker</title><script src="./index-s27r7dsg.js"></script>'], 'ui/dist/index.html', { type: 'text/html' }),
  new File(['console.log(1)'], 'ui/dist/index-s27r7dsg.js'),
  new File(['body{}'], 'ui/dist/index-x0qywj6z.css'),
  new File(['other'], 'node_modules/x/readme.txt'),
]

describe('uiAssetMap', () => {
  test('resolves index.html and hashed assets by URL name; ignores files outside the UI root', () => {
    const m = uiAssetMap(files)
    expect([...m.keys()].sort()).toEqual(['index-s27r7dsg.js', 'index-x0qywj6z.css', 'index.html'])
    expect(m.get('index.html')!.size).toBe(files[0]!.size)
  })
  test('finds the UI root whatever prefix Bun gives it (dist/ from the repo root build)', () => {
    const m = uiAssetMap([new File(['i'], 'dist/index.html'), new File(['j'], 'dist/index-abc.js'), new File(['n'], 'dist/sub/index.html')])
    expect([...m.keys()].sort()).toEqual(['index-abc.js', 'index.html', 'sub/index.html'])
  })
  test('accepts ./-prefixed names and returns undefined source when index.html is missing', () => {
    expect([...uiAssetMap([new File(['x'], './ui/dist/index.html')]).keys()]).toEqual(['index.html'])
    expect(embeddedUi([files[1]!])).toBeUndefined()
    expect(embeddedUi(files)).toBeDefined()
  })
})

describe('server with embedded UI', () => {
  let root: string, store: Store, srv: RunningServer, base: string
  beforeAll(async () => {
    root = await miniCopy()
    store = await Store.open(root, { port: 0 })
    srv = startServer(store, { port: 0, version: 'test', ui: embeddedUi(files)! })
    base = `http://127.0.0.1:${srv.port}`
  })
  afterAll(async () => {
    await srv.stop()
    await rm(root, { recursive: true, force: true })
  })

  test('serves index.html at / and hashed assets with their MIME types', async () => {
    const r = await fetch(`${base}/`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await r.text()).toContain('index-s27r7dsg.js')
    const js = await fetch(`${base}/index-s27r7dsg.js`)
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toContain('text/javascript')
    expect(await js.text()).toBe('console.log(1)')
    expect((await fetch(`${base}/index-x0qywj6z.css`)).headers.get('content-type')).toContain('text/css')
  })

  test('404 for unknown names and anything outside the map', async () => {
    for (const p of ['/nope.js', '/..%2fnode_modules%2fx%2freadme.txt', '/node_modules/x/readme.txt', '/%E0%A4%A']) {
      expect((await fetch(`${base}${p}`)).status).toBeGreaterThanOrEqual(400)
    }
  })
})
