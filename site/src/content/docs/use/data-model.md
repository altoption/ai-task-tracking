---
title: Data model and importing
description: The data folder, the issue file format and config.yml, and how an agent brings issues over from another tool.
sidebar:
  order: 4
---

AI Task Tracking has no built-in importer. Your own AI agent moves your issues over: it reads them from the old tool
(an export file, an API, or that tool's MCP server) and writes them here, either through the MCP tools or as files.
This page is written for that agent. Everything on it comes from the code that reads and writes the files
(`src/store/issueFile.ts`, `src/store/metaFiles.ts`, `src/model.ts`).

## The data folder

Default `~/AITaskTracking`; `defaults read io.github.altoption.ai-task-tracking trackerHome` prints the folder the
app uses. It is plain text and a git repo.

```text
~/AITaskTracking/
├── config.yml                  statuses, id counters, repo → project mapping, Needs-you rules
├── labels.yml                  label names and colors
├── AGENTS.md                   the rules agents get as the MCP server's instructions
├── .gitignore                  written by the app
├── views/<slug>.yml            saved views (the app writes these)
├── themes/<name>.yml           your own themes (optional; see the Themes guide)
├── projects/
│   └── <project-slug>/
│       ├── project.md          name, key, status, milestones; body = description
│       ├── issues/<ID>.md      one file per issue, e.g. issues/WEB-12.md
│       ├── docs/<slug>.md      project documents (front matter: title)
│       └── files/<name>        attachments, linked from issue text as ../files/<name>
└── .tracker/                   this Mac's caches (activity log, CI status); git-ignored, never import into it
```

- The project's **slug** is its folder name: lowercase letters, digits and dashes (the app makes it from the name,
  e.g. "Web App" → `web-app`).
- An issue's project is the folder its file is in. There is no `project:` key in the issue file.
- Only `*.md` files directly in `issues/` are issues; names starting with `.` are skipped.

## Issue ids and project keys

- An id is `<KEY>-<number>`, e.g. `WEB-12`. `KEY` is the project's `key` from `project.md`.
- Ids are unique across the whole folder. A second file with an id that is already loaded is rejected and listed as
  a file that can't be read.
- Name each file after its id (`issues/WEB-12.md`). New ids skip any number that already has a file, so a file
  named after its id can never be overwritten by a new issue.
- `config.yml` keeps the next number per key under `nextNumber` (`WEB: 13` means the next new issue is `WEB-13`).
  After writing files by hand, set it to one more than the highest number you used.
- Keys never change once issues use them. When the old tool's ids are already `KEY-n`, you can keep them: give the
  project that key and write each issue under its old id.

## The issue file

YAML front matter between `---` lines, then the description in Markdown, then an optional `## Activity` section with
the comments.

```markdown
---
id: WEB-12
title: "Checkout: card form loses input on error"
status: In Progress
priority: 2
labels: [Bug, Scope/Checkout]
parent: WEB-10
blocked_by: [WEB-11]
related: [WEB-7]
milestone: Beta
due: 2026-12-01
plan: null
links: [{title: "PR #57", url: "https://github.com/acme/web/pull/57"}]
created: 2026-10-02T09:14:00Z
updated: 2026-10-05T16:40:00Z
source: https://old-tracker.example.com/browse/SHOP-881
---
The form clears every field when the card is declined.

## Acceptance
- [ ] Entered values survive a declined card

## Activity
### 2026-10-03T10:02:00Z · you
Seen on Safari and Chrome.
### 2026-10-05T16:40:00Z · agent · web (fix/card-form)
Root cause: the form remounts on error. PR opened.
```

### Front-matter keys

| Key | Value | If missing |
|---|---|---|
| `id` | `KEY-n`. **Required**: a file without it can't be read. | — |
| `title` | Text. Quote it when it contains `: ` or starts with a YAML character (`"`, `[`, `{`, `#`, …). | empty |
| `status` | A status `name` from `config.yml` (default list below), exactly as written there. | empty |
| `priority` | `0` none, `1` urgent, `2` high, `3` medium, `4` low. | `0` |
| `labels` | List of label names. A grouped label is written in full: `Scope/Checkout`. | `[]` |
| `parent` | Id of the parent issue (an epic), or `null`. | `null` |
| `blocked_by` | Ids of the issues that block this one. Write it on the blocked issue only: "blocks" is worked out from it. | `[]` |
| `related` | Ids of related issues. Write it on both issues (the tools do). | `[]` |
| `milestone` | A milestone `name` from the project's `project.md`, or `null`. | `null` |
| `due` | `YYYY-MM-DD`, or `null`. | `null` |
| `plan` | `now`, `next`, `later` or `null`: the owner's Now / Next / Later board. | `null` |
| `links` | List of `{title, url}`. | `[]` |
| `created`, `updated` | ISO 8601 UTC, e.g. `2026-10-02T09:14:00Z`. Keep the old tool's dates. | empty |
| `touched_by` | Who wrote last: `{actor: agent, workspace: web, branch: main}`. The app writes it; leave it out when importing. | — |

Any other key (like `source:` above) is kept as it is, in its place, through every later edit. That is the place for
the old tool's id or URL.

Ids in `parent`, `blocked_by` and `related` may point into other projects. The tools refuse an id that doesn't exist;
in a file it is kept as written, so check that every id you reference is imported too.

### Description and activity

- The description is everything after the front matter up to `## Activity` (or the end). Plain GitHub-flavoured
  Markdown; `- [ ]` task lists are checklists agents can tick (`toggle_task`). A single newline is a line break.
- `## Activity` starts the comments, oldest first. Each comment starts with a heading line, then its text:
  - `### <time> · you` for the owner's comments;
  - `### <time> · agent · <workspace>` or `### <time> · agent · <workspace> (<branch>)` for an agent's;
  - `<time>` is ISO 8601 and must start with `YYYY-MM-DDT`, e.g. `2026-10-03T10:02:00Z`.

  Comments from another tool's users have no exact match. Use `you` and start the text with the author, e.g.
  `**Dana (imported):** Seen on Safari.`
- A line in the description or a comment that starts with `## Activity` or `### <time> · ` at the start of the line
  would be read as structure: indent it by one space.
- Images and other files: put them in `projects/<slug>/files/` and link them as `../files/<name>`
  (`![screenshot](../files/form-error.png)`).

## Statuses

Statuses live in `config.yml`. Each has a `name`, a `color` and a `type`; the type decides the behaviour (open or
closed, which board column, what counts as in progress). The defaults:

| name | type |
|---|---|
| Backlog | `backlog` |
| Todo | `unstarted` |
| In Progress | `started` |
| Waiting | `started` (waiting on the owner; shows in Needs you) |
| Done | `completed` |
| Canceled | `canceled` |
| Duplicate | `duplicate` |

Map each of the old tool's states to one of these. To keep an old state, add it to `statuses:` with the type that
fits (types: `backlog`, `unstarted`, `started`, `completed`, `canceled`, `duplicate`). An issue whose `status` isn't
in the list is treated as `backlog`.

## Labels

`labels.yml` holds the labels the app offers, with their colors:

```yaml
labels:
  - {name: Bug, color: "#eb5757"}
  - {name: Feature, color: "#bb87fc"}
  - {name: Scope/Checkout, color: "#26b5ce"}
```

- `Group/Name` makes a grouped label (here group `Scope`); views can group issues by a label group. Agents may then
  use the bare name (`Checkout`) when it matches exactly one grouped label.
- The defaults are Bug, Feature, Improvement, Task (the type labels every issue should have one of), Needs decision,
  Needs review and Blocked.
- The tools create a label the first time it is used. When writing files, add every label you use to `labels.yml`.

## Projects

`projects/<slug>/project.md`:

```markdown
---
name: Website
key: WEB
status: Active
color: "#26b5ce"
repos: [web]
milestones:
  - {name: Beta, description: Public beta, target: 2027-02-01}
---
The marketing site and the shop.
```

- `name` (defaults to the slug), `key` (the id prefix; required for new issues), `status` (default `Active`; e.g.
  Planned, Active, Completed), optional `color`, `repos`, and `milestones` (`name`, optional `description` and
  `target` date). The body is the project's description.
- `repos` lists the repos that file into this project. The mapping the tools actually use is `workspaces:` in
  `config.yml`; keep the two in step.
- `docs/<slug>.md` files are project documents: front matter `title:`, Markdown body.

## config.yml

```yaml
port: 7477
statuses:
  - {name: Backlog, type: backlog, color: "#bec2c8"}
  # … the rest of the list above
workspaces:
  web: website
needsYou:
  statuses: [Waiting, In Review]
  labels: [Needs decision, Needs review]
nextNumber:
  WEB: 13
```

- `workspaces`: repo (or folder) name → project slug. An agent's new issue goes to the project mapped to its repo
  when it doesn't name one.
- `nextNumber`: the next issue number per project key (see [Issue ids](#issue-ids-and-project-keys)).
- `needsYou`, `stalled`, `ci`, `theme` and `port`: see the [config.yml reference](/docs/reference/config/). Leave keys you
  don't need out; missing keys take their defaults. Comments and unknown keys are kept when the app rewrites the
  file.

## A small worked example

Moving three issues from an old tracker into a new project "Website" with key `WEB`: an epic with two steps, where
step 2 waits on step 1 and step 1 is done.

`projects/website/project.md`:

```markdown
---
name: Website
key: WEB
status: Active
repos: [web]
milestones: []
---
Imported from the old tracker on 2026-10-29.
```

`projects/website/issues/WEB-1.md`:

```markdown
---
id: WEB-1
title: "Epic: New checkout"
status: In Progress
priority: 2
labels: [Feature]
parent: null
blocked_by: []
related: []
milestone: null
due: null
plan: null
links: []
created: 2026-09-01T08:00:00Z
updated: 2026-10-01T12:00:00Z
source: SHOP-100
---
Replace the old checkout with a one-page flow.
```

`projects/website/issues/WEB-2.md`:

```markdown
---
id: WEB-2
title: "Step 1: Card form"
status: Done
priority: 2
labels: [Task]
parent: WEB-1
blocked_by: []
related: []
milestone: null
due: null
plan: null
links: [{title: "PR #57", url: "https://github.com/acme/web/pull/57"}]
created: 2026-09-01T08:05:00Z
updated: 2026-09-20T15:30:00Z
source: SHOP-101
---
Card number, expiry and CVC on one line.

## Activity
### 2026-09-20T15:30:00Z · you
**Dana (imported):** Shipped in PR #57.
```

`projects/website/issues/WEB-3.md`:

```markdown
---
id: WEB-3
title: "Step 2: Address autocomplete"
status: Todo
priority: 3
labels: [Task]
parent: WEB-1
blocked_by: [WEB-2]
related: []
milestone: null
due: null
plan: null
links: []
created: 2026-09-01T08:06:00Z
updated: 2026-09-01T08:06:00Z
source: SHOP-102
---
Suggest addresses as the user types.
```

And in `config.yml`, `nextNumber: {WEB: 4}` and `workspaces: {web: website}`.

The same issues through the MCP tools. New ids are assigned, so `ref:` names stand in for them, and `save_project`
makes the key from the name (`Website` becomes `WEBSI`, so the ids are `WEBSI-1` to `WEBSI-3`):

```js
save_project({ name: "Website", description: "Imported from the old tracker on 2026-10-29." })
save_issues({ issues: [
  { ref: "epic", project: "Website", title: "Epic: New checkout", labels: ["Feature"], priority: 2,
    state: "In Progress", description: "Replace the old checkout with a one-page flow.\n\nImported from SHOP-100." },
  { ref: "s1", project: "Website", parentId: "ref:epic", title: "Step 1: Card form", labels: ["Task"], priority: 2,
    state: "Done", comment: "Imported: shipped in PR #57.", links: [{ url: "https://github.com/acme/web/pull/57", title: "PR #57" }] },
  { project: "Website", parentId: "ref:epic", title: "Step 2: Address autocomplete", labels: ["Task"], priority: 3,
    state: "Todo", blockedBy: ["ref:s1"] },
] })
```

## Importing safely

There are two ways. Pick one per import, and test it first on a scratch folder (below).

### Through the MCP tools (the app running)

`save_issues` creates or updates several issues in one call; every item is checked before any is written.

- Send **batches of about 50**, each one a whole subtree: an epic and its children in the same batch, so the
  children can use `parentId: "ref:<name>"` and `blockedBy: ["ref:<name>"]` (refs work in `parentId` and
  `blockedBy`, within one call).
- Create the projects first (`save_project`), then the milestones (`save_milestone`); a milestone must exist before
  an issue uses it. The tools can't choose a project's key: a one-word name gives its first five letters, several
  words their initials. To pick the key, quit the app, write that project's `project.md` by hand (with `key:`, and
  `nextNumber` for it in `config.yml`), and open the app again before importing.
- Every new issue needs at least one label and a status from `list_issue_statuses`; pass `project` (without it the
  issue goes to the project mapped to your repo). Creating or moving an issue in Done, Canceled, Duplicate or
  Waiting needs a `comment` (say it was imported).
- An issue created or moved to In Progress also lands in the owner's Now slot; import open work as Todo when that
  isn't wanted.
- Each result item carries its `ref`. Keep a map of old id → new id from the results. Relations that cross batches (a blocker created in an earlier
  batch, `relatedTo`) go in a later `save_issue` with the real ids.
- Old comments go in with `save_comment`. Search before re-running a batch (`search`), so a retry doesn't make
  duplicates; when a tool says it "didn't reply… may have been applied", check with `list_issues` first.

Good for: tens to a few hundred issues, and when the app should stay open. Trade-off: ids are new, `created` and
`updated` are the import time, comments are dated the import time and written as the agent, and keys other than
the standard ones can't be set.

### Writing the files (the app stopped)

Writing the files keeps the old ids, dates, comment history and any extra keys, and is the faster way for hundreds
or thousands of issues.

1. **Quit AI Task Tracking** (menu bar ▸ Quit) so the engine isn't writing while you are. It commits its last change
   when it quits.
2. Write `project.md` for each project, then the issue files, as above. Add every status to `config.yml` and every
   label to `labels.yml`, and set `nextNumber` for each key.
3. Check the files before opening the app (next section).
4. **Open the app.** It reads the folder, commits the new files to its git repo ("recovered uncommitted changes")
   and pushes them with the next backup. A file it can't read is listed in the sidebar ("N files can't be read",
   with the reason) and left alone.

Don't write into the folder while the app is running: the app sees every file change and commits as it goes, and a
new issue an agent creates meanwhile can take a number you were about to use.

### Check on a scratch folder first

Run an import against a scratch folder first, on a port other than the app's (7477). Use a new, empty folder, or a
copy of the real one without its git repo, so the test can never push to your backup:

```sh
mkdir /tmp/aitt-import-test
rsync -a --exclude .git --exclude .tracker ~/AITaskTracking/ /tmp/aitt-import-test/   # optional: start from your data
# … write the import into /tmp/aitt-import-test …
AITT_HOME=/tmp/aitt-import-test AITT_PORT=7499 aitt serve & pid=$!
sleep 2; curl -s http://127.0.0.1:7499/api/snapshot | jq '.errors, (.issues | length)'
```

`errors` lists every file that couldn't be read and why (missing `id`, invalid YAML, a duplicate id); it must be
empty. The issue count must match what you imported. Open `http://127.0.0.1:7499` to look at the result, then stop
it with `kill $pid` and do the real import.
