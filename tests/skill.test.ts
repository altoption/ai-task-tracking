import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { toolSchemas as TOOLS } from '../src/tools/schemas'

const SKILL = join(import.meta.dir, '../skills/ai-task-tracking/SKILL.md')

describe('agent skill skills/ai-task-tracking/SKILL.md', () => {
  test('frontmatter: name ai-task-tracking; description triggers on tracking, epics, what next', async () => {
    const text = await readFile(SKILL, 'utf8')
    const fm = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(text)
    expect(fm?.[1]).toBe('ai-task-tracking')
    for (const w of [/track/i, /epic/i, /what's next/i]) expect(fm?.[2]).toMatch(w)
  })

  test('tight (<150 lines) and covers workflow, errors and install', async () => {
    const text = await readFile(SKILL, 'utf8')
    expect(text.split('\n').length).toBeLessThan(150)
    for (const s of ["isn't running", "didn't reply", 'Waiting', 'Needs you', 'altoption/ai-task-tracking', 'aitt setup']) expect(text).toContain(s)
  })

  test('every tool name it mentions is a real Tracker tool', async () => {
    const text = await readFile(SKILL, 'utf8')
    const named = new Set([...text.matchAll(/`([a-z]+_[a-z_]+)[(`]/g)].map((m) => m[1]!))
    expect(named.size).toBeGreaterThan(10)
    const real = new Set(Object.keys(TOOLS))
    expect([...named].filter((n) => !real.has(n))).toEqual([])
  })
})

describe('milestone and issue-link guidance (skill and default AGENTS.md say the same)', async () => {
  const { DEFAULT_AGENTS_MD } = await import('../src/store/metaFiles')
  const sources = { skill: await readFile(SKILL, 'utf8'), 'default AGENTS.md': DEFAULT_AGENTS_MD }
  for (const [name, text] of Object.entries(sources)) {
    test(`${name}: milestones only for one project's dated or named outcome, never invented, children assigned`, () => {
      for (const s of [/save_milestone/, /ONE project/, /targetDate/, /release|pilot|demo/, /never invent/i, /children, not just the epic/, /labels/, /epic/]) expect(text).toMatch(s)
    })
    test(`${name}: pausing leaves a one-line handoff comment (done, next, blocking)`, () => {
      expect(text.replace(/\s+/g, ' ')).toContain("Pausing (ending the session or switching issues): leave a one-line handoff comment: what's done, what's next, what's blocking.")
    })
    test(`${name}: mention an issue as a markdown link to url plus the appUrl`, () => {
      expect(text).toMatch(/\[[A-Z]+-1 [^\]]+\]\(http:\/\/127\.0\.0\.1:7477\/#\/issue\/[A-Z]+-1\) · aitt:\/\/issue\/[A-Z]+-1/)
    })
  }
})
