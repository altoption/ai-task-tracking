import { cp, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const fixture = join(import.meta.dir, '../fixtures/mini')

/** Fresh temp copy of tests/fixtures/mini (never mutate the fixture in place). */
export async function miniCopy(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tracker-engine-'))
  await cp(fixture, root, { recursive: true })
  return root
}

export const issuePath = (root: string, project: string, id: string) => join(root, 'projects', project, 'issues', `${id}.md`)
