import type { GitHandle } from '../engine/git'

export interface ShutdownParts {
  /** stop() must stop listening and let in-flight requests finish (bounded) before resolving. */
  server: { stop(): Promise<void> }
  watcher: { close(): void }
  git: Pick<GitHandle, 'flush' | 'stop' | 'status'>
  /** Upper bound for the final commit+push. */
  deadlineMs: number
  log?: (msg: string) => void
}

/**
 * Stop taking writes (server, then watcher), then make the final commit with a deadline.
 * Resolves with the process exit code: 0 normally, 1 if the commit failed. A hung push only costs the deadline.
 */
export async function shutdown({ server, watcher, git, deadlineMs, log = (m) => console.error(m) }: ShutdownParts): Promise<number> {
  let code = 0
  const stopTimer: { t?: ReturnType<typeof setTimeout> } = {}
  try {
    const timedOut = await Promise.race([
      server.stop().then(() => false),
      new Promise<boolean>((r) => { stopTimer.t = setTimeout(() => r(true), deadlineMs) }),
    ])
    if (timedOut) log(`shutdown: server stop exceeded ${deadlineMs} ms; continuing`)
  } catch (e) { log(`shutdown: server stop failed: ${e}`) }
  if (stopTimer.t) clearTimeout(stopTimer.t)
  try { watcher.close() } catch (e) { log(`shutdown: watcher close failed: ${e}`) }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timedOut = await Promise.race([
      git.flush().then(() => false),
      new Promise<boolean>((r) => { timer = setTimeout(() => r(true), deadlineMs) }),
    ])
    if (timedOut) log(`shutdown: git flush exceeded ${deadlineMs} ms; exit code decided from git status`)
  } catch (e) {
    log(`shutdown: git flush failed: ${e}`)
    code = 1
  } finally {
    if (timer) clearTimeout(timer)
  }
  try {
    const err = git.status().commitError
    if (err) { log(`shutdown: final commit failed: ${err}`); code = 1 }
    git.stop()
  } catch (e) { log(`shutdown: git status/stop failed: ${e}`) }
  return code
}
