#!/usr/bin/env bash
# Agent eval for the MCP tool surface: runs `claude -p` through five everyday tracking tasks against a
# throwaway data folder and engine, then reports the tool calls each task used, the tool errors it hit and
# whether the final state is right. Use it after changing tool descriptions, results or AGENTS.md.
#
#   scripts/agent-eval.sh [--model <model>] [--keep] [--user-context]
#
# Isolation: a scratch AITT_HOME and port, `--mcp-config <scratch json> --strict-mcp-config` (your MCP config
# is never read or written), `--tools ""` (no built-in tools) and no session persistence. By default the agent
# also gets no user context: `--setting-sources project` from a scratch folder (no user CLAUDE.md, hooks or
# plugins) with CLAUDE.md files and auto-memory disabled, plus --bare when ANTHROPIC_API_KEY is set.
# --user-context loads your user settings, CLAUDE.md and memory instead (your user hooks then run too).
# Costs a few cents of model use per run.
set -euo pipefail

MODEL=haiku
KEEP=0
USER_CONTEXT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --model) MODEL="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --user-context) USER_CONTEXT=1; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "$0")/.." && pwd)"
command -v claude >/dev/null || { echo "claude CLI not found" >&2; exit 1; }
command -v bun >/dev/null || { echo "bun not found" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl not found" >&2; exit 1; }

DIR="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/aitt-eval.XXXXXX")" && pwd -P)" # physical path: the engine reports its home that way
HOME_DIR="$DIR/data"
WS="$DIR/csv-reports" # the agent's working folder; its name becomes the workspace and default project
mkdir -p "$HOME_DIR" "$WS"

ENGINE_PID=""
cleanup() {
  if [ -n "$ENGINE_PID" ]; then kill "$ENGINE_PID" 2>/dev/null || true; wait "$ENGINE_PID" 2>/dev/null || true; fi
  if [ "$KEEP" = 1 ]; then echo "kept: $DIR"; else rm -rf "$DIR"; fi
}
trap cleanup EXIT

# Our engine is up on $PORT: it answers /api/health for our data folder (not some other server that took the port).
engine_ready() {
  curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null \
    | HOME_DIR="$HOME_DIR" bun -e 'process.exit(JSON.parse(await Bun.stdin.text()).home === process.env.HOME_DIR ? 0 : 1)' 2>/dev/null
}

# A free port can be taken between picking it and binding it: if the engine exits or the port is someone
# else's, pick another and retry.
PORT=""
for _ in 1 2 3 4 5; do
  PORT="$(bun -e 'const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() }); console.log(s.port); s.stop(true)')"
  AITT_HOME="$HOME_DIR" AITT_PORT="$PORT" bun "$REPO/src/cli.ts" serve >"$DIR/engine.log" 2>&1 &
  ENGINE_PID=$!
  for _ in $(seq 1 50); do
    engine_ready && break
    kill -0 "$ENGINE_PID" 2>/dev/null || break
    sleep 0.2
  done
  engine_ready && break
  kill "$ENGINE_PID" 2>/dev/null || true; wait "$ENGINE_PID" 2>/dev/null || true
  ENGINE_PID=""
done
[ -n "$ENGINE_PID" ] || { echo "engine did not start; see $DIR/engine.log" >&2; KEEP=1; exit 1; }

# Calls a tool as the owner (reads and seeding only).
tool() {
  curl -fsS -X POST "http://127.0.0.1:$PORT/api/tool/$1" -H 'content-type: application/json' -H 'X-Tracker: 1' --data "{\"args\": $2}"
}

# Seed, as an earlier agent in the same folder (this also creates the folder's project): an older issue for task 5.
curl -fsS -X POST "http://127.0.0.1:$PORT/api/tool/save_issue" -H 'content-type: application/json' -H 'X-Tracker: 1' -H 'X-Tracker-Agent: 1' \
  --data '{"args": {"title": "Reports page times out for date ranges over a year", "labels": ["Bug"], "description": "Large report queries hit the 30 s timeout."}, "ctx": {"actor": {"actor": "agent", "workspace": "csv-reports"}}}' >"$DIR/seed.json"
SEED_ID="$(bun -e 'console.log(JSON.parse(await Bun.stdin.text()).id)' <"$DIR/seed.json")"

# Built as JSON (paths may contain quotes or backslashes).
# shellcheck disable=SC2016 # the program below is JavaScript, not shell
REPO="$REPO" HOME_DIR="$HOME_DIR" PORT="$PORT" bun -e '
const { REPO, HOME_DIR, PORT } = process.env
console.log(JSON.stringify({ mcpServers: { "ai-task-tracking": {
  command: "bun", args: [`${REPO}/src/cli.ts`, "mcp"], env: { AITT_HOME: HOME_DIR, AITT_PORT: PORT } } } }, null, 1))
' >"$DIR/mcp.json"

PROMPTS=(
  "Plan CSV export for the reports page as an epic with 3 steps: add an export button, stream the rows as CSV, add a download progress bar. Track it, then reply with the issue links."
  "What should I work on next? Answer in two lines."
  "The first step of the CSV export epic is done; it shipped in https://github.com/example/app/pull/42. Record that."
  "I can't continue the CSV streaming step until the owner decides the delimiter (comma or semicolon). Hand it back to the owner."
  "There is an older issue about the reports page timing out. Find it and link it as related to the CSV export epic."
)

EXTRA=()
NO_USER=()
if [ "$USER_CONTEXT" = 1 ]; then
  EXTRA+=(--setting-sources "user,project")
else
  EXTRA+=(--setting-sources project)
  NO_USER=(CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1)
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then EXTRA+=(--bare); fi
fi

i=0
for p in "${PROMPTS[@]}"; do
  i=$((i + 1))
  (cd "$WS" && env ${NO_USER[@]+"${NO_USER[@]}"} claude -p "$p" --model "$MODEL" --mcp-config "$DIR/mcp.json" --strict-mcp-config \
    --tools "" --allowedTools "mcp__ai-task-tracking" --no-session-persistence \
    --output-format stream-json --verbose "${EXTRA[@]}" >"$DIR/task$i.jsonl" 2>"$DIR/task$i.err") || echo "task $i: claude exited $?" >&2
done

# Report: per task, the tools called (in order) and every tool error; then the state checks.
tool list_issues '{"includeArchived": true, "limit": 250}' >"$DIR/issues.json"
# shellcheck disable=SC2016 # the program below is JavaScript, not shell
DIR="$DIR" SEED_ID="$SEED_ID" N="$i" PORT="$PORT" bun -e '
const dir = process.env.DIR, n = Number(process.env.N)
let calls = 0, errors = 0
for (let k = 1; k <= n; k++) {
  const lines = (await Bun.file(`${dir}/task${k}.jsonl`).text()).split("\n").filter(Boolean).map((l) => JSON.parse(l))
  const uses = new Map(), seq = [], errs = []
  let answer = ""
  for (const m of lines) {
    for (const b of m.message?.content ?? []) {
      if (b.type === "tool_use") { uses.set(b.id, b); seq.push(b.name.replace(/^mcp__ai-task-tracking__/, "")) }
      if (b.type === "tool_result" && b.is_error) {
        const t = Array.isArray(b.content) ? b.content.map((c) => c.text ?? "").join(" ") : String(b.content)
        errs.push(`${uses.get(b.tool_use_id)?.name ?? "?"}: ${t.slice(0, 300)}`)
      }
    }
    if (m.type === "result") answer = m.result ?? ""
  }
  calls += seq.length; errors += errs.length
  console.log(`task ${k}: ${seq.length} calls [${seq.join(", ")}], ${errs.length} errors`)
  for (const e of errs) console.log(`  error ${e}`)
  console.log(`  answer: ${answer.replace(/\s+/g, " ").slice(0, 300)}`)
}
const issues = JSON.parse(await Bun.file(`${dir}/issues.json`).text()).issues
const get = async (id) => (await fetch(`http://127.0.0.1:${process.env.PORT}/api/tool/get_issue`, { method: "POST", headers: { "content-type": "application/json", "X-Tracker": "1" }, body: JSON.stringify({ args: { id } }) })).json()
const epic = issues.find((i) => /csv/i.test(i.title) && i.childCount >= 3)
const kids = epic ? issues.filter((i) => i.parent === epic.id) : []
const full = await Promise.all(kids.map((k) => get(k.id)))
const chained = full.filter((k) => k.blockedBy.length).length
const checks = [
  ["epic with 3 children", !!epic && kids.length === 3],
  ["steps chained with blockedBy", chained >= 2],
  ["a step Done with the PR link", full.some((k) => k.status === "Done" && k.links.some((l) => l.url.includes("/pull/42")))],
  ["a step Waiting", full.some((k) => k.status === "Waiting")],
  ["epic related to the seeded issue", !!epic && (await get(epic.id)).related.includes(process.env.SEED_ID)],
  ["no duplicate epics", issues.filter((i) => /csv/i.test(i.title) && i.childCount > 0).length === 1],
]
for (const [what, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${what}`)
console.log(`total: ${calls} tool calls, ${errors} tool errors, ${checks.filter((c) => c[1]).length}/${checks.length} checks`)
'
