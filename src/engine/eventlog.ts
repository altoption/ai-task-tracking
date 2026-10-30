import { existsSync, readFileSync } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Actor } from '../model'

export interface FeedEvent {
  at: string; actor: Actor; id: string
  kind: 'created' | 'status' | 'comment' | 'blocked' | 'parent' | 'updated'
  from?: string; to?: string; text?: string
}

/** `<root>/.tracker/events.jsonl` — an append-only cache (git-ignored), not a source of truth. */
export const feedPath = (root: string) => join(root, '.tracker', 'events.jsonl')

// Appends per root are chained so lines land in call order.
const chains = new Map<string, Promise<void>>()

export function appendEvent(root: string, e: FeedEvent): Promise<void> {
  const next = (chains.get(root) ?? Promise.resolve()).then(async () => {
    await mkdir(join(root, '.tracker'), { recursive: true })
    await appendFile(feedPath(root), JSON.stringify(e) + '\n', 'utf8')
  })
  const settled = next.catch(() => {})
  chains.set(root, settled)
  void settled.then(() => { if (chains.get(root) === settled) chains.delete(root) })
  return next
}

/** Newest first, at most `limit` events. Corrupt lines are skipped. */
export function readFeed(root: string, limit: number): FeedEvent[] {
  const p = feedPath(root)
  if (!existsSync(p)) return []
  const lines = readFileSync(p, 'utf8').split('\n')
  const out: FeedEvent[] = []
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const l = lines[i]!.trim()
    if (!l) continue
    try { out.push(JSON.parse(l) as FeedEvent) } catch { /* partial or corrupt line */ }
  }
  return out
}
