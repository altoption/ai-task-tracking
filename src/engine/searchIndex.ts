import type { Issue } from '../model'

/** Field bits; a word's score in an issue is the weight of the best field it appears in. */
const TITLE = 4, DESC = 2, ACT = 1
const WEIGHT = (mask: number) => (mask & TITLE ? 100 : mask & DESC ? 10 : 1)

const WORD = /[\p{L}\p{N}]+/gu
export const tokenize = (s: string): string[] => s.toLowerCase().match(WORD) ?? []

/**
 * Inverted index: lowercase word -> (issue id -> field mask). No dependencies.
 * Query semantics: every term must match; each term matches words it is a prefix of
 * (so typing "fan tab" finds "fan ... tables").
 */
export class SearchIndex {
  private postings = new Map<string, Map<string, number>>()
  private words = new Map<string, string[]>() // id -> indexed words, for removal

  set(issue: Issue): void {
    const id = issue.id
    this.remove(id)
    const words: string[] = []
    const add = (text: string, bit: number) => {
      for (const w of tokenize(text)) {
        let p = this.postings.get(w)
        if (!p) this.postings.set(w, (p = new Map()))
        const m = p.get(id)
        if (m === undefined) { p.set(id, bit); words.push(w) } else if (!(m & bit)) p.set(id, m | bit)
      }
    }
    add(issue.title, TITLE)
    add(issue.description, DESC)
    for (const e of issue.activity) add(e.body, ACT)
    this.words.set(id, words)
  }

  remove(id: string): void {
    const ws = this.words.get(id)
    if (!ws) return
    for (const w of ws) {
      const p = this.postings.get(w)
      if (!p) continue
      p.delete(id)
      if (p.size === 0) this.postings.delete(w)
    }
    this.words.delete(id)
  }

  /** id -> score for issues matching every term (empty when there are no terms). */
  query(q: string): Map<string, number> {
    const terms = [...new Set(tokenize(q))]
    let acc: Map<string, number> | null = null
    for (const t of terms) {
      const hit = new Map<string, number>() // id -> best weight for this term
      const take = (p: Map<string, number>) => {
        for (const [id, m] of p) {
          if (acc && !acc.has(id)) continue
          const w = WEIGHT(m)
          if ((hit.get(id) ?? 0) < w) hit.set(id, w)
        }
      }
      for (const [w, p] of this.postings) if (w.startsWith(t)) take(p)
      if (acc) for (const [id, w] of hit) hit.set(id, w + acc.get(id)!)
      acc = hit
      if (acc.size === 0) break
    }
    return acc ?? new Map()
  }
}
