import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/engine/store'
import { serveDocs, startServer, type RunningServer } from '../../src/server/http'
import { diskUi, docsAssetMap, embeddedDocs, embeddedUi, uiAssetMap } from '../../src/server/uiAssets'
import { miniCopy } from '../engine/helpers'

// What `bun build --compile --asset ui/dist --asset site/dist/docs` embeds: the UI as dist/…, the docs as docs/….
const files = [
  new File(['<!doctype html><title>UI</title>'], 'dist/index.html'),
  new File(['console.log("ui")'], 'dist/index-abc.js'),
  new File(['<!doctype html><title>Docs home</title>'], 'docs/index.html'),
  new File(['<!doctype html><title>Install</title>'], 'docs/start/install/index.html'),
  new File(['<!doctype html><title>Not found</title>'], 'docs/404.html'),
  new File(['body{}'], 'docs/_astro/common.css'),
  new File(['export {}'], 'docs/pagefind/pagefind.js'),
  new File(['{"version":"1"}'], 'docs/pagefind/pagefind-entry.json'),
  new File([new Uint8Array([31, 139, 8])], 'docs/pagefind/wasm.en.pagefind'),
  new File([new Uint8Array([1, 2])], 'docs/pagefind/index/en_1.pf_index'),
  new File(['secret'], 'node_modules/x/secret.txt'),
]

describe('embedded asset maps', () => {
  test('the docs site and the UI are told apart, even when their index.html names are the same length', () => {
    expect([...uiAssetMap(files).keys()].sort()).toEqual(['index-abc.js', 'index.html'])
    const d = docsAssetMap(files)
    expect(d.has('index.html') && d.has('start/install/index.html') && d.has('pagefind/wasm.en.pagefind')).toBe(true)
    expect([...d.keys()].some((k) => k.includes('node_modules') || k.startsWith('dist/'))).toBe(false)
    // Order doesn't matter: docs listed first still leave the UI root at dist/.
    expect([...uiAssetMap([...files].reverse()).keys()].sort()).toEqual(['index-abc.js', 'index.html'])
  })
  test('a binary without docs has no docs source, and its UI is unchanged', () => {
    const uiOnly = files.filter((f) => !f.name.startsWith('docs/'))
    expect(embeddedDocs(uiOnly)).toBeUndefined()
    expect(embeddedUi(uiOnly)!.get('index.html')).toBeDefined()
  })
})

describe('GET /docs/', () => {
  let root: string, store: Store, srv: RunningServer, base: string
  beforeAll(async () => {
    root = await miniCopy()
    store = await Store.open(root, { port: 0 })
    srv = startServer(store, { port: 0, version: 'test', ui: embeddedUi(files)!, docs: embeddedDocs(files)! })
    base = `http://127.0.0.1:${srv.port}`
  })
  afterAll(async () => {
    await srv.stop()
    await rm(root, { recursive: true, force: true })
  })
  const get = (p: string) => fetch(`${base}${p}`, { redirect: 'manual' })

  test('/docs redirects to /docs/, which serves the docs home', async () => {
    const r = await get('/docs?x=1')
    expect(r.status).toBe(301)
    expect(r.headers.get('location')).toBe('/docs/?x=1')
    const home = await get('/docs/')
    expect(home.status).toBe(200)
    expect(home.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await home.text()).toContain('Docs home')
  })

  test('a deep page serves its index.html; without the trailing slash it redirects', async () => {
    expect(await (await get('/docs/start/install/')).text()).toContain('Install')
    const r = await get('/docs/start/install')
    expect(r.status).toBe(301)
    expect(r.headers.get('location')).toBe('/docs/start/install/')
  })

  test('assets and the Pagefind index get their content types', async () => {
    const types: Record<string, string> = {
      '/docs/_astro/common.css': 'text/css; charset=utf-8',
      '/docs/pagefind/pagefind.js': 'text/javascript; charset=utf-8',
      '/docs/pagefind/pagefind-entry.json': 'application/json',
      '/docs/pagefind/wasm.en.pagefind': 'application/octet-stream',
      '/docs/pagefind/index/en_1.pf_index': 'application/octet-stream',
    }
    for (const [p, type] of Object.entries(types)) {
      const r = await get(p)
      expect(`${p} ${r.status} ${r.headers.get('content-type')}`).toBe(`${p} 200 ${type}`)
      expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    }
  })

  test('hashed _astro assets are cached for good; pages and the Pagefind index are revalidated', async () => {
    expect((await get('/docs/_astro/common.css')).headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    for (const p of ['/docs/', '/docs/start/install/', '/docs/pagefind/pagefind.js', '/docs/pagefind/pagefind-entry.json',
      '/docs/pagefind/wasm.en.pagefind', '/docs/pagefind/index/en_1.pf_index', '/docs/nope/']) {
      expect(`${p} ${(await get(p)).headers.get('cache-control')}`).toBe(`${p} no-cache`)
    }
  })

  test('a missing page is a 404 with the site\'s 404 page, never the UI', async () => {
    for (const p of ['/docs/nope/', '/docs/nope', '/docs/start/install/missing.js']) {
      const r = await get(p)
      expect(r.status).toBe(404)
      const body = await r.text()
      expect(body).toContain('Not found')
      expect(body).not.toContain('<title>UI')
    }
  })

  test('/docs never shadows the API or the UI', async () => {
    expect((await (await get('/api/health')).json()).ok).toBe(true)
    expect(await (await get('/')).text()).toContain('<title>UI')
    expect((await get('/docsx')).status).toBe(404) // not a docs path: the UI's static handler
  })

  test('encoded traversal and hidden or odd segments are refused', async () => {
    for (const p of ['/docs/..%2f..%2fdist%2findex.html', '/docs/%2e%2e%2fnode_modules%2fx%2fsecret.txt', '/docs/.env',
      '/docs/start/..%5c..%5csecret.txt', '/docs/a%00.html', '/docs//index.html', '/docs/%E0%A4%A']) {
      const r = await get(p)
      expect(`${p} ${r.status}`).toMatch(/ 40[04]$/)
      expect(await r.text()).not.toContain('secret')
    }
  })

  test('without a docs build: a 404 that says how to build them', async () => {
    const r = serveDocs(diskUi('/nonexistent-docs-dir'), '/docs/')
    expect(r.status).toBe(404)
    expect(await r.text()).toContain('bun run docs:build')
  })
})

describe('serveDocs from disk', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aitt-docs-'))
    await mkdir(join(dir, 'site', 'start'), { recursive: true })
    await writeFile(join(dir, 'site', 'index.html'), 'home')
    await writeFile(join(dir, 'site', '404.html'), 'missing page')
    await writeFile(join(dir, 'site', 'start', 'index.html'), 'start')
    await writeFile(join(dir, 'secret.txt'), 'secret')
    await mkdir(join(dir, 'site', '_astro'))
    await writeFile(join(dir, 'site', '_astro', 'real.css'), 'body{}')
    await symlink(join(dir, 'secret.txt'), join(dir, 'site', 'leak.txt')) // file link out of the site
    await symlink(dir, join(dir, 'site', 'up')) // folder link out of the site
    await symlink(join(dir, 'site', '_astro', 'real.css'), join(dir, 'site', 'inside.css')) // link within the site
    await symlink(join(dir, 'gone.txt'), join(dir, 'site', 'dangling.txt'))
  })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  test('raw and encoded ../ never leave the docs folder', async () => {
    const docs = diskUi(join(dir, 'site'))
    expect(await serveDocs(docs, '/docs/start/').text()).toBe('start')
    for (const p of ['/docs/../secret.txt', '/docs/start/../../secret.txt', '/docs/%2e%2e/secret.txt', '/docs/..%2fsecret.txt',
      '/docs/start/%2E%2E%2F%2E%2E%2Fsecret.txt', '/docs/..\\secret.txt']) {
      const r = serveDocs(docs, p)
      expect(`${p} ${r.status}`).toBe(`${p} 404`)
      expect(await r.text()).toBe('missing page')
    }
  })

  test('a symlink that leads out of the docs folder is never followed; one that stays inside is', async () => {
    const docs = diskUi(join(dir, 'site'))
    for (const p of ['/docs/leak.txt', '/docs/up/secret.txt', '/docs/dangling.txt']) {
      const r = serveDocs(docs, p)
      expect(`${p} ${r.status}`).toBe(`${p} 404`)
      expect(await r.text()).toBe('missing page')
    }
    expect(await serveDocs(docs, '/docs/inside.css').text()).toBe('body{}')
  })
})
