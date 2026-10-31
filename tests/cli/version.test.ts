import { expect, test } from 'bun:test'
import { join } from 'node:path'
import pkg from '../../package.json'

// The installer runs this on a new build before it quits the old app, so it must work without a data folder.
test('aitt --version prints the version and exits 0', async () => {
  const p = Bun.spawn([process.execPath, join(import.meta.dir, '../../src/cli.ts'), '--version'], {
    env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
  expect(code).toBe(0)
  expect(out.trim()).toBe(pkg.version)
})
