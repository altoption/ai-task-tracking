/**
 * GitHub link detection, shared by the engine (rule 6: PR, commit and branch URLs in comments become issue links) and
 * the UI (Home's Agent activity shows the same links as chips).
 */
import type { Link } from '../model'

const GH = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull\/(\d+)|commit\/([0-9a-f]{7,40})|tree\/([^\s)\]>"'`]+))/gi

/** GitHub PR / commit / branch URLs in `text`, normalized and deduplicated, in order of appearance. */
export function extractLinks(text: string | undefined): Link[] {
  if (!text) return []
  const out: Link[] = []
  for (const m of text.matchAll(GH)) {
    const [, owner, repo, , pr, sha, branchRaw] = m
    const base = `https://github.com/${owner}/${repo}`
    let link: Link
    if (pr) link = { title: `PR #${pr}`, url: `${base}/pull/${pr}` }
    else if (sha) link = { title: `Commit ${sha.slice(0, 7)}`, url: `${base}/commit/${sha}` }
    else {
      const branch = branchRaw!.replace(/[.,;:!?]+$/, '')
      link = { title: `Branch ${branch}`, url: `${base}/tree/${branch}` }
    }
    if (!out.some((l) => l.url === link.url)) out.push(link)
  }
  return out
}
