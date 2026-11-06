import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ATTACH_MAX_BYTES, readUploads, storeAttachments } from '../../src/tools/attachments'
import { Store } from '../../src/engine/store'
import { startServer, type RunningServer } from '../../src/server/http'
import { miniCopy } from '../engine/helpers'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
let scratch: string
let project: string
let outside: string

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'aitt-attach-'))
  // The project and the "outside" folder must not be under the temp folder, which is allowed: use a fake root list.
  project = join(scratch, 'proj')
  outside = join(scratch, 'outside')
  await mkdir(join(project, 'shots'), { recursive: true })
  await mkdir(outside)
  await writeFile(join(project, 'shots', 'before.png'), PNG)
  await writeFile(join(project, 'notes.svg'), '<svg onload="alert(1)"/>')
  await writeFile(join(outside, 'secret.png'), PNG)
  await symlink(join(outside, 'secret.png'), join(project, 'shots', 'link.png'))
  await writeFile(join(project, 'big.png'), Buffer.alloc(ATTACH_MAX_BYTES + 1))
})
afterAll(async () => { await rm(scratch, { recursive: true, force: true }) })

describe('readUploads (proxy side)', () => {
  test('reads files inside the allowed folders, relative to the cwd', async () => {
    const [u] = await readUploads([{ path: 'shots/before.png' }], project, [project])
    expect(u).toEqual({ path: 'shots/before.png', data: PNG.toString('base64') })
  })
  test('refuses other types, files outside (also through a symlink), missing and oversized files', async () => {
    const got = await readUploads([
      { path: 'notes.svg' }, { path: join(outside, 'secret.png') }, { path: 'shots/link.png' },
    ], project, [project])
    expect(got.map((u) => u.data)).toEqual([undefined, undefined, undefined])
    expect(got[0]!.error).toContain('only png')
    expect(got[1]!.error).toContain('inside the project folder')
    expect(got[2]!.error).toContain('inside the project folder')
    const [missing, big] = await readUploads([{ path: 'nope.png' }, { path: 'big.png' }], project, [project])
    expect(missing!.error).toContain('not found')
    expect(big!.error).toContain('larger than 5 MB')
  })
  test('at most 4, and junk entries are skipped', async () => {
    const list = [null, 7, { path: '' }, ...Array.from({ length: 6 }, () => ({ path: 'shots/before.png' }))]
    expect((await readUploads(list, project, [project])).length).toBeLessThanOrEqual(4)
    expect(await readUploads('nope', project, [project])).toEqual([])
  })
})

describe('storeAttachments (engine side)', () => {
  test('stores under an engine-chosen name and returns markdown; the same bytes reuse the file', async () => {
    const root = join(scratch, 'data1')
    const up = [{ path: 'shots/before.png', data: PNG.toString('base64') }]
    const md = await storeAttachments(root, { id: 'WEB-3', project: 'website' }, [{ path: 'shots/before.png', alt: 'before [old](x)' }], up)
    expect(md).toMatch(/^!\[before old x\]\(\.\.\/files\/web-3-[0-9a-f]{8}\.png\)$/)
    const name = /files\/(.*)\)/.exec(md)![1]!
    expect(await readFile(join(root, 'projects', 'website', 'files', name))).toEqual(PNG)
    expect(await storeAttachments(root, { id: 'WEB-3', project: 'website' }, [{ path: 'shots/before.png' }], up)).toBe(`![before](../files/${name})`)
  })
  test('errors: no upload for a path, an upload error, a bad type, no project, too many', async () => {
    const root = join(scratch, 'data2')
    const issue = { id: 'WEB-3', project: 'website' }
    await expect(storeAttachments(root, issue, [{ path: 'a.png' }], undefined)).rejects.toThrow('agent connection')
    await expect(storeAttachments(root, issue, [{ path: 'a.png' }], [{ path: 'a.png', error: 'a.png: file not found' }])).rejects.toThrow('file not found')
    await expect(storeAttachments(root, issue, [{ path: 'a.svg' }], [{ path: 'a.svg', data: 'PHN2Zz4=' }])).rejects.toThrow('only png')
    await expect(storeAttachments(root, { id: 'X-1', project: '_none' }, [{ path: 'a.png' }], [])).rejects.toThrow('in a project')
    await expect(storeAttachments(root, issue, Array.from({ length: 5 }, () => ({ path: 'a.png' })), [])).rejects.toThrow('At most 4')
  })
})

describe('save_comment with attachments over HTTP', () => {
  let root: string
  let srv: RunningServer
  beforeAll(async () => {
    root = await miniCopy()
    srv = startServer(await Store.open(root, { port: 0 }), { port: 0, version: 'test' })
  })
  afterAll(async () => { await srv.stop(); await rm(root, { recursive: true, force: true }) })
  const post = (body: unknown, agent = true) => fetch(`http://127.0.0.1:${srv.port}/api/tool/save_comment`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-Tracker': '1', ...(agent ? { 'X-Tracker-Agent': '1' } : {}) }, body: JSON.stringify(body),
  })

  test('an agent comment gets the image, served from /files', async () => {
    const r = await post({
      args: { issueId: 'Q-1', body: 'Ready.', attachments: [{ path: 'after.png', alt: 'after' }] },
      ctx: { actor: { actor: 'agent', workspace: 'shop' }, uploads: [{ path: 'after.png', data: PNG.toString('base64') }] },
    })
    expect(r.status).toBe(200)
    const list: any = await (await fetch(`http://127.0.0.1:${srv.port}/api/tool/list_comments`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Tracker': '1' }, body: JSON.stringify({ args: { issueId: 'Q-1' } }) })).json()
    const body: string = list.comments.at(-1).body
    const name = /\(\.\.\/files\/(q-1-[0-9a-f]{8}\.png)\)/.exec(body)![1]!
    const img = await fetch(`http://127.0.0.1:${srv.port}/files/acme-app/${name}`)
    expect(img.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await img.arrayBuffer())).toEqual(PNG)
  })
  test('uploads from a non-agent caller are ignored: the call fails and names why', async () => {
    const r = await post({ args: { issueId: 'Q-1', body: 'x', attachments: [{ path: 'a.png' }] }, ctx: { uploads: [{ path: 'a.png', data: PNG.toString('base64') }] } }, false)
    expect(r.status).toBe(400)
    expect(((await r.json()) as any).error).toContain('agent connection')
  })
})
