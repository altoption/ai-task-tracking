import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CONCEPT_ICON, ConceptIcon, ICON_PATHS, type Concept } from '../../ui/components/icons'
import { CATEGORIES } from '../../ui/views/FilterMenu'

/** One icon per concept (ATT-49): no shape stands for two things. */
describe('concept icons', () => {
  test('every concept has its own icon key and its own path', () => {
    const keys = Object.values(CONCEPT_ICON)
    expect(new Set(keys).size).toBe(keys.length)
    for (const k of keys) expect(ICON_PATHS[k]).toBeTruthy()
    const paths = keys.map((k) => ICON_PATHS[k])
    expect(new Set(paths).size).toBe(paths.length)
  })

  test('no two icons in the set share a path', () => {
    const all = Object.values(ICON_PATHS)
    expect(new Set(all).size).toBe(all.length)
  })

  test('each filter category shows its own concept\'s icon', () => {
    const want: Record<string, string> = {
      status: 'status', priority: 'priority', labels: 'label', relations: 'relations', links: 'link', parent: 'parent',
      workspace: 'workspace', milestone: 'milestone', content: 'content', dates: 'calendar', project: 'project',
    }
    expect(CATEGORIES.map((c): string => c.id).sort()).toEqual(Object.keys(want).sort())
    for (const c of CATEGORIES) {
      expect(CONCEPT_ICON[c.id]).toBe(want[c.id] as (typeof CONCEPT_ICON)[Concept])
      const svg = renderToStaticMarkup(createElement(ConceptIcon, { concept: c.id }))
      expect(svg).toContain(`d="${ICON_PATHS[want[c.id]!]}"`)
    }
  })

  test('the reused shapes from before are gone: Labels is not Views, Priority not Filter, Workspace not Home', () => {
    expect(CONCEPT_ICON.labels).not.toBe(CONCEPT_ICON.views)
    expect(CONCEPT_ICON.priority).not.toBe(CONCEPT_ICON.filter)
    expect(CONCEPT_ICON.workspace).not.toBe(CONCEPT_ICON.home)
    expect(CONCEPT_ICON.status).not.toBe(CONCEPT_ICON.issues)
    expect(CONCEPT_ICON.parent).not.toBe(CONCEPT_ICON.issues)
    expect(CONCEPT_ICON.relations).not.toBe(CONCEPT_ICON.links)
    expect(CONCEPT_ICON.theme).not.toBe(CONCEPT_ICON.display)
    expect(CONCEPT_ICON.content).not.toBe(CONCEPT_ICON.search)
  })

  test('views pick concept icons, not raw names, except for navigation glyphs', () => {
    const NAV = new Set(['chevron', 'x', 'back', 'forward', 'sidebar', 'plus'])
    const dir = join(import.meta.dir, '../../ui/views')
    const raw = readdirSync(dir).flatMap((f) =>
      [...readFileSync(join(dir, f), 'utf8').matchAll(/<Icon name="([a-z]+)"/g)].map((m) => m[1]!).filter((n) => !NAV.has(n)).map((n) => `${f}: ${n}`))
    expect(raw).toEqual([])
  })
})
