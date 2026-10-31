import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Actor } from '../model'
import { GITIGNORE_LINES, TEMP_NAME } from '../store/atomic'
import { ensureGitignoreLine } from '../store/metaFiles'
import type { FeedEvent } from './eventlog'
import { EXTERNAL, type Store } from './store'

export interface GitStatus {
  lastCommit?: string; lastPush?: string; pushError?: string; commitError?: string
  /** Changes not committed yet: a write waiting for the debounce, a commit running, or one that failed. */
  pending?: boolean
  /** Commits on HEAD that origin doesn't have (all of them if never pushed); 0 without an `origin` remote. Cached. */
  ahead?: number
  /** An `origin` remote exists (as of the last commit or push). */
  remote?: boolean
}
/** Outcome of `sync()`: `ok` is false when the commit or the push failed (the error is the redacted git message). */
export interface SyncResult { ok: boolean; committed: boolean; pushed: boolean; commitError?: string; pushError?: string }
export interface GitHandle {
  /** Startup is done (repo initialised, leftovers noted): a change made after this gets its own commit message. */
  ready: Promise<void>
  /** Commit anything pending now, then push if an `origin` remote exists. Never rejects. */
  flush(): Promise<void>
  /**
   * Commit now (including a dirty tree no store event announced), then push to origin unless `push` is false.
   * Never rejects; failures are in the result (and in status()).
   */
  sync(opts?: { push?: boolean }): Promise<SyncResult>
  /** Re-read `ahead`/`remote` and look for uncommitted changes in the tree (a hand-made commit or edit), then status(). */
  refresh(): Promise<GitStatus>
  /** Unsubscribe from the store and clear timers. */
  stop(): void
  /** Cheap and synchronous. Timestamps are ISO strings. */
  status(): GitStatus
}

const MAX_CHANGES = 5
const PUSH_TIMEOUT_MS = 60_000
const GIT_TIMEOUT_MS = 30_000

/** First meaningful stderr line with URL credentials masked, capped at 300 chars. */
export function redact(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return line.replace(/:\/\/[^/@\s]+@/g, '://***@').slice(0, 300)
}

interface Fallback { actor: Actor; id: string; text: string }
interface Pending { actors: Actor[]; changes: string[]; feedIds: Set<string>; fallbacks: Fallback[] }
const emptyPending = (): Pending => ({ actors: [], changes: [], feedIds: new Set(), fallbacks: [] })

const feedSummary = (e: FeedEvent, external: boolean): string => {
  switch (e.kind) {
    case 'created': return `new ${e.id}`
    case 'status': return `${e.id} → ${e.to ?? 'updated'}`
    case 'comment': return `comment on ${e.id}`
    case 'blocked': return `${e.id} blockers changed`
    case 'parent': return `${e.id} parent → ${e.to || 'none'}`
    default: return external ? `edited ${e.id}` : `updated ${e.id}`
  }
}

const prefix = (a: Actor): string => {
  if (a.actor === 'you') return a.workspace === 'external' ? 'external' : 'you'
  return a.workspace ? `agent(${a.workspace})` : 'agent'
}

/**
 * Debounced auto-commit (and push, when an `origin` remote exists) of the data folder.
 * All git commands run one at a time through a single promise chain.
 */
export function startGit(store: Store, opts: { commitDelayMs: number; pushDelayMs: number; gitTimeoutMs?: number }): GitHandle {
  const root = store.root
  const st: GitStatus = { ahead: 0, remote: false }
  let pending: Pending = emptyPending()
  let dirty = false
  let committing = false
  /** Set by refresh(): the tree has changes no store event announced (cleared by the next commit attempt). */
  let treeDirty = false
  let commitTimer: ReturnType<typeof setTimeout> | undefined
  let pushTimer: ReturnType<typeof setTimeout> | undefined
  let chain: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn)
    chain = p.catch(() => {})
    return p
  }

  async function git(args: string[], pre: string[] = []): Promise<{ ok: boolean; out: string; err: string }> {
    const timeout = opts.gitTimeoutMs ?? (args[0] === 'push' ? PUSH_TIMEOUT_MS : GIT_TIMEOUT_MS)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const p = Bun.spawn(['git', ...pre, ...args], {
        cwd: root, stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' },
      })
      // Race the output against the timer: a killed git can leave a grandchild (hook, ssh) holding the pipes open.
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => { p.kill(); resolve('timeout') }, timeout)
      })
      const done = Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
      done.catch(() => {})
      const res = await Promise.race([done, timedOut])
      if (res === 'timeout') return { ok: false, out: '', err: `git ${args[0]} timed out after ${timeout} ms` }
      const [out, err] = res
      return { ok: p.exitCode === 0, out: out.trim(), err: err.trim() }
    } catch (e) {
      return { ok: false, out: '', err: e instanceof Error ? e.message : String(e) }
    } finally {
      clearTimeout(timer)
    }
  }

  const note = (a: Actor, change: string) => {
    dirty = true
    pending.actors.push(a)
    if (!pending.changes.includes(change)) pending.changes.push(change)
  }
  // An issue/meta event marks the tree dirty; the feed event (arriving separately) supplies the readable
  // summary, so fallback text is only used for ids no feed event names.
  const noteFallback = (actor: Actor, id: string, text: string) => {
    dirty = true
    pending.fallbacks.push({ actor, id, text })
  }

  /** Changed or untracked paths in the working tree, temp files excluded. */
  async function dirtyPaths(): Promise<string[]> {
    const s = await git(['status', '--porcelain', '-z', '--untracked-files=all'])
    return s.ok ? s.out.split('\0').filter(Boolean).map((e) => e.slice(3)).filter((p) => !TEMP_NAME.test(basename(p))) : []
  }

  /** Cache `remote` and `ahead`; on first sight of the tracking ref, take lastPush from its reflog. */
  async function refreshRemote() {
    const remotes = await git(['remote'])
    st.remote = remotes.ok && remotes.out.split('\n').includes('origin')
    if (!st.remote || !(await git(['rev-parse', '-q', '--verify', 'HEAD'])).ok) { st.ahead = 0; return }
    const branch = await git(['symbolic-ref', '--short', '-q', 'HEAD'])
    const tracking = branch.ok && branch.out ? `refs/remotes/origin/${branch.out}` : ''
    const pushedBefore = !!tracking && (await git(['rev-parse', '-q', '--verify', tracking])).ok
    const n = await git(['rev-list', '--count', pushedBefore ? `${tracking}..HEAD` : 'HEAD'])
    st.ahead = n.ok ? Number(n.out) || 0 : 0
    if (pushedBefore && !st.lastPush) {
      // `<ref>@{<unix time>}`: when the tracking ref last moved (a push, or a fetch).
      const r = await git(['reflog', 'show', '-1', '--date=unix', '--format=%gd', tracking])
      const t = /@\{(\d+)\}$/.exec(r.out)
      if (r.ok && t) st.lastPush = new Date(Number(t[1]) * 1000).toISOString()
    }
  }

  /**
   * Startup: init the repo if needed, commit anything left uncommitted by a crash, and keep
   * atomicWrite temp files out of git (ignore them; untrack any that were committed earlier).
   */
  async function init() {
    const fresh = !existsSync(join(root, '.git'))
    if (fresh) {
      const r = await git(['init', '-b', 'main'])
      if (!r.ok) { st.pushError = redact(`git init failed: ${r.err}`); return }
      note(EXTERNAL, 'initial import')
    } else {
      // Dirty before we touch anything (temp files don't count): a crash between write and commit.
      if ((await dirtyPaths()).length) note(EXTERNAL, 'recovered uncommitted changes')
    }
    try {
      let added = false
      for (const line of GITIGNORE_LINES) if (await ensureGitignoreLine(root, line)) added = true
      if (added) note(EXTERNAL, 'ignore temp files')
    } catch (e) {
      console.error('[git] could not update .gitignore:', e instanceof Error ? e.message : String(e))
    }
    if (!fresh) {
      const ls = await git(['ls-files', '-z'])
      const tracked = ls.ok ? ls.out.split('\0').filter((p) => p && TEMP_NAME.test(basename(p))) : []
      if (tracked.length && (await git(['rm', '--cached', '-q', '--ignore-unmatch', '--', ...tracked])).ok) {
        note(EXTERNAL, `untrack ${tracked.length} temp file${tracked.length === 1 ? '' : 's'}`)
      }
    }
    await refreshRemote()
    if (dirty) schedule()
  }

  /** Put a snapshot back in front of whatever accumulated while the commit was running. */
  function restore(p: Pending) {
    const q = pending
    pending = {
      actors: [...p.actors, ...q.actors],
      changes: [...p.changes, ...q.changes.filter((c) => !p.changes.includes(c))],
      feedIds: new Set([...p.feedIds, ...q.feedIds]),
      fallbacks: [...p.fallbacks, ...q.fallbacks],
    }
    dirty = true
    schedule()
  }

  /** 'none': nothing to commit. On failure the changes go back to pending and the timer is re-armed. */
  async function commit(): Promise<'none' | 'ok' | 'failed'> {
    if (treeDirty && !dirty) note(EXTERNAL, 'uncommitted changes')
    treeDirty = false
    if (!dirty) return 'none'
    committing = true
    try { return await commitPending() } finally { committing = false }
  }

  async function commitPending(): Promise<'none' | 'ok' | 'failed'> {
    const p = pending
    pending = emptyPending()
    dirty = false
    const actors = [...p.actors], changes = [...p.changes]
    for (const f of p.fallbacks) {
      if (f.id && p.feedIds.has(f.id)) continue
      actors.push(f.actor)
      if (!changes.includes(f.text)) changes.push(f.text)
    }
    const shown = changes.slice(0, MAX_CHANGES)
    const more = changes.length - shown.length
    const msg = `${prefix(actors[0] ?? EXTERNAL)}: ${shown.join(', ')}${more > 0 ? ` +${more} more` : ''}`
    const fail = (err: string) => { st.commitError = redact(err) || 'git commit failed'; restore(p); return 'failed' as const }
    const add = await git(['add', '-A'])
    if (!add.ok) return fail(add.err)
    if ((await git(['diff', '--cached', '--quiet'])).ok) { delete st.commitError; return 'none' } // nothing staged
    const hasName = (await git(['config', 'user.name'])).out && (await git(['config', 'user.email'])).out
    const pre = hasName ? [] : ['-c', 'user.name=AI Task Tracking', '-c', 'user.email=aitt@localhost']
    const r = await git(['commit', '-m', msg], pre)
    if (!r.ok) return fail(r.err || r.out)
    delete st.commitError
    st.lastCommit = new Date().toISOString()
    await refreshRemote()
    armPush()
    return 'ok'
  }

  async function push(): Promise<'none' | 'ok' | 'failed'> {
    const remotes = await git(['remote'])
    st.remote = remotes.ok && remotes.out.split('\n').includes('origin')
    if (!st.remote) { st.ahead = 0; return 'none' }
    const r = await git(['push', 'origin', 'HEAD'])
    if (r.ok) { st.lastPush = new Date().toISOString(); st.ahead = 0; delete st.pushError; return 'ok' }
    st.pushError = redact(r.err) || 'git push failed'
    armPush() // retry next cycle
    return 'failed'
  }

  function schedule() {
    clearTimeout(commitTimer)
    commitTimer = setTimeout(() => { void enqueue(commit) }, opts.commitDelayMs)
  }
  function armPush() {
    clearTimeout(pushTimer)
    pushTimer = setTimeout(() => { void enqueue(push) }, opts.pushDelayMs)
  }

  const ready = enqueue(init)

  const unsubscribe = store.on((e) => {
    switch (e.kind) {
      case 'feed': {
        pending.feedIds.add(e.event.id)
        note(e.event.actor, feedSummary(e.event, e.event.actor.workspace === 'external'))
        break
      }
      case 'issue': noteFallback(e.actor, e.issue.id, `${e.actor.workspace === 'external' ? 'edited' : 'updated'} ${e.issue.id}`); break
      case 'removed': noteFallback(e.actor, e.id, `removed ${e.id}`); break
      case 'meta': noteFallback(EXTERNAL, '', e.note ?? 'config changed'); break
      case 'file': noteFallback(EXTERNAL, '', `${e.deleted ? 'deleted' : 'edited'} ${e.path}`); break
      default: return
    }
    schedule()
  })

  return {
    ready,
    async flush() {
      clearTimeout(commitTimer)
      clearTimeout(pushTimer)
      await ready
      await enqueue(commit)
      clearTimeout(pushTimer) // the push below covers any timer armed by that commit
      await enqueue(push)
    },
    async sync({ push: doPush = true } = {}) {
      await ready
      return enqueue(async (): Promise<SyncResult> => {
        clearTimeout(commitTimer)
        if (!dirty && (await dirtyPaths()).length) note(EXTERNAL, 'uncommitted changes')
        const c = await commit()
        if (c === 'failed') return { ok: false, committed: false, pushed: false, commitError: st.commitError ?? 'git commit failed' }
        const committed = c === 'ok'
        if (!doPush) return { ok: true, committed, pushed: false }
        clearTimeout(pushTimer)
        const p = await push()
        if (p === 'failed') return { ok: false, committed, pushed: false, pushError: st.pushError ?? 'git push failed' }
        return { ok: true, committed, pushed: p === 'ok' }
      })
    },
    stop() {
      unsubscribe()
      clearTimeout(commitTimer)
      clearTimeout(pushTimer)
    },
    async refresh() {
      await ready
      // Read-only git, outside the chain: a running push must not hold up the app's quit check.
      await refreshRemote()
      if (!dirty && !committing) treeDirty = (await dirtyPaths()).length > 0
      return { ...st, pending: dirty || committing || treeDirty }
    },
    status: () => ({ ...st, pending: dirty || committing || treeDirty }),
  }
}
