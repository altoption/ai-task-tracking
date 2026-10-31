import { z } from 'zod'

/**
 * Tool input schemas and their agent-facing text. The tool list is product UI for agents: each description is
 * one purpose line, when to use it rather than a sibling, and one minimal example; every argument says what it
 * takes. Keep it short — every session pays for it (tests/mcp/surface.test.ts caps the size).
 *
 * Every schema is a plain `z.object`; unknown arguments are stripped, so args other trackers' tools take
 * (e.g. `team`, `assignee`) are accepted and ignored.
 */

/** get_issue shows this many of the newest activity entries; list_comments returns all. */
export const ACTIVITY_CAP = 30

const id = z.string().min(1)
const ids = z.array(id)
const issueId = id.describe('Issue id, e.g. "ENG-27".')

/** save_issue's fields. `d` adds the descriptions; save_issues items reuse the fields without them (its `issues` arg points here). */
function issueFields(d: boolean) {
  const t = <T extends z.ZodType>(s: T, text: string): T => (d ? s.describe(text) : s)
  const link = z.object({ url: t(z.string().min(1), 'URL.'), title: t(z.string().optional(), 'Text.') })
  return {
    id: t(id.optional(), 'Issue to update, e.g. "ENG-27"; omit to create.'),
    title: t(z.string().min(1).optional(), 'Required to create.'),
    description: t(z.string().optional(), 'Markdown; replaces the whole description.'),
    state: t(z.string().optional(), 'Status name, e.g. Todo, In Progress, Waiting, Done, Canceled (see list_issue_statuses). Done, Canceled, Duplicate and Waiting need comment.'),
    priority: t(z.number().int().min(0).max(4).optional(), '0 none, 1 urgent, 2 high, 3 medium, 4 low.'),
    project: t(z.string().optional(), 'Project name or slug; on create, defaults to your repo\'s project.'),
    parentId: t(id.nullable().optional(), 'Parent issue id; null removes it. In save_issues also "ref:<ref>".'),
    milestone: t(z.string().nullable().optional(), 'Milestone name in the project; null clears it.'),
    labels: t(z.array(z.string().min(1)).optional(), 'Replaces all labels; creating needs one. Bare names match group labels ("Web" = "Scope/Web"); new names are created.'),
    addLabels: t(z.array(z.string().min(1)).optional(), 'Labels to add.'),
    removeLabels: t(z.array(z.string().min(1)).optional(), 'Labels to remove.'),
    blockedBy: t(ids.optional(), 'Ids of blocking issues; replaces the list ([] clears). In save_issues also "ref:<ref>".'),
    addBlockedBy: t(ids.optional(), 'Blocker ids to add.'),
    removeBlockedBy: t(ids.optional(), 'Blocker ids to remove.'),
    relatedTo: t(ids.optional(), 'Related issue ids; replaces the list (set on both issues).'),
    addRelatedTo: t(ids.optional(), 'Related ids to add.'),
    removeRelatedTo: t(ids.optional(), 'Related ids to remove.'),
    dueDate: t(z.string().nullable().optional(), 'YYYY-MM-DD; null clears it.'),
    links: t(z.array(link).optional(), 'Links to add: [{ url, title }].'),
    removeLinks: t(z.array(z.string().min(1)).optional(), 'Link URLs to remove.'),
    baseDescription: t(z.string().optional(), 'The text you edited from; the save is refused if it changed since.'),
    comment: t(z.string().optional(), 'Comment saved with the change. Required for Done, Canceled, Duplicate, Waiting: what shipped or what it waits on. GitHub PR/commit URLs in it become issue links.'),
  }
}

const saveIssue = z.object(issueFields(true))
const batchItem = z.object({
  ...issueFields(false),
  ref: z.string().min(1).optional().describe('Name for this item; later items refer to it as "ref:<name>" in parentId or blockedBy.'),
})

const filter = z.object({
  status: z.array(z.string()).optional(), project: z.array(z.string()).optional(), labels: z.array(z.string()).optional(),
  parent: z.string().nullable().optional(), workspace: z.array(z.string()).optional(), priority: z.array(z.number().int()).optional(),
  blocked: z.boolean().optional(), query: z.string().optional(), updatedAfter: z.string().optional(), includeDone: z.boolean().optional(),
  milestone: z.array(z.string()).optional(), createdAfter: z.string().optional(),
  blocking: z.boolean().optional(), hasRelated: z.boolean().optional(), hasLinks: z.boolean().optional(),
  closedWithinDays: z.number().int().positive().optional(),
})
const display = z.object({
  layout: z.enum(['list', 'board']), groupBy: z.string(), rowsBy: z.string().optional(), orderBy: z.string(),
  showSubIssues: z.boolean(), properties: z.array(z.string()),
  showEmptyColumns: z.boolean().optional(), showEmptyRows: z.boolean().optional(),
  completed: z.enum(['none', 'day', 'week', 'month', 'all']).optional(),
})

const project = z.string().min(1).describe('Project name or slug.')

export interface ToolSchema {
  /** Short human name (MCP `title`). */
  title: string
  description: string
  input: z.ZodObject<any>
  /** Only reads (MCP readOnlyHint). */
  readOnly?: boolean
  /** Repeating the same call changes nothing more (MCP idempotentHint). */
  idempotent?: boolean
}

const defs = {
  // ----- issues: read -----
  whats_next: {
    title: 'What to work on next', readOnly: true,
    description: 'What to work on, in buckets: needsYou (waiting on the user), inProgress, readyNext (unblocked, by priority) and blocked (with blocker ids). Stalled issues carry stalled (why), failing PR checks ci (why); stalled lists your workspace\'s. Use it at the start of a session when no issue is named.',
    input: z.object({}),
  },
  get_issue: {
    title: 'Get issue', readOnly: true,
    description: `One issue in full (In Progress ones lead with handoff: where the last session stopped): description, links (PRs with ci: state, checks, failing), children, blockers, ancestors, the last ${ACTIVITY_CAP} activity entries (list_comments has all), attempts (agent sessions so far) and stalled (why) if it stalled. For an epic's whole subtree use get_tree. Example: get_issue({ id: "ENG-27" })`,
    input: z.object({ id: issueId }),
  },
  get_tree: {
    title: 'Get issue tree', readOnly: true,
    description: 'An issue and all its descendants with status, blockers and done/total progress; use it to check an epic. Example: get_tree({ id: "ENG-10" })',
    input: z.object({ id: issueId }),
  },
  search: {
    title: 'Search issues', readOnly: true,
    description: 'Find issues by words in title, description and comments, closed ones included. Every word must match (prefixes count), so use 1-3 distinctive words. Search before creating an issue so you don\'t duplicate one. Example: search({ query: "login timeout" })',
    input: z.object({
      query: z.string().min(1).describe('Words to find.'),
      limit: z.number().int().min(1).max(250).optional().describe('Max results, 1-250 (default 20).'),
    }),
  },
  list_issues: {
    title: 'List issues', readOnly: true,
    description: 'Issues matching filters, most recently updated first. Open issues only unless state names a closed status or includeArchived is true. To find by words use search. Example: list_issues({ project: "Website", state: "In Progress" })',
    input: z.object({
      state: z.string().optional().describe('Status name, case-insensitive.'),
      project: z.string().optional().describe('Project name or slug.'),
      label: z.string().optional().describe('Label name; bare names match group labels.'),
      parentId: id.optional().describe('Only children of this issue id.'),
      query: z.string().optional().describe('Words to match in title, description and comments.'),
      updatedAt: z.string().optional().describe('Updated after this ISO date/time, or within a duration like "-P7D".'),
      limit: z.number().int().min(1).max(250).optional().describe('Page size, 1-250 (default 50).'),
      cursor: z.string().optional().describe('nextCursor from the previous page.'),
      includeArchived: z.boolean().optional().describe('Include Done, Canceled and Duplicate issues.'),
    }),
  },
  list_comments: {
    title: 'List comments', readOnly: true,
    description: `All of an issue's comments and activity, oldest first (get_issue shows only the last ${ACTIVITY_CAP}). Example: list_comments({ issueId: "ENG-27" })`,
    input: z.object({ issueId }),
  },

  // ----- issues: write -----
  save_issue: {
    title: 'Save issue',
    description: 'Create or update one issue. Create: title and labels (project defaults to your repo\'s). Update: id and only the fields to change. For several issues at once (an epic and its steps) use save_issues. Example: save_issue({ id: "ENG-27", state: "Done", comment: "Shipped in PR #12" })',
    input: saveIssue,
  },
  save_issues: {
    title: 'Save issues (batch)',
    description: 'Create or update several issues in one call; every item is checked before any is written. Use it for an epic and its steps. Example: save_issues({ issues: [{ ref: "epic", title: "Epic: import", labels: ["Feature"] }, { ref: "s1", parentId: "ref:epic", title: "Step 1: parse", labels: ["Task"] }, { parentId: "ref:epic", title: "Step 2: load", labels: ["Task"], blockedBy: ["ref:s1"] }] })',
    input: z.object({ issues: z.array(batchItem).min(1).describe('Items in order. Each takes the save_issue arguments (same names and meanings) plus ref.') }),
  },
  save_comment: {
    title: 'Add comment',
    description: 'Add a comment to an issue: findings, decisions, PR links (GitHub PR/commit URLs are also added to its links). When you also change the status, pass comment to save_issue instead. Example: save_comment({ issueId: "ENG-27", body: "Root cause: stale cache." })',
    input: z.object({ issueId, body: z.string().min(1).describe('Markdown text.') }),
  },
  toggle_task: {
    title: 'Tick checklist item',
    description: 'Tick or untick one "- [ ]" checklist item in an issue description without rewriting it. Example: toggle_task({ id: "ENG-42", index: 0, line: "- [ ] Write the migration" })',
    input: z.object({
      id: issueId,
      index: z.number().int().min(0).describe('Position among the description\'s checklist lines, from 0 (code blocks skipped).'),
      line: z.string().describe('The item\'s current line; refused if it no longer matches.'),
    }),
  },
  set_plan: {
    title: 'Put issue in Now', idempotent: true,
    description: 'Put an issue in the user\'s Now slot. Agents may only set "now" (moving to In Progress does it too); Next and Later belong to the user. Example: set_plan({ id: "ENG-27", plan: "now" })',
    input: z.object({ id: issueId, plan: z.enum(['now', 'next', 'later']).nullable().describe('"now". (next, later and null are for the user.)') }),
  },

  // ----- projects, milestones, documents -----
  list_projects: {
    title: 'List projects', readOnly: true,
    description: 'All projects with their issue-id key, status and open/total issue counts.',
    input: z.object({}),
  },
  get_project: {
    title: 'Get project', readOnly: true,
    description: 'One project: description, milestones with progress, document ids and mapped repos. Example: get_project({ query: "Website" })',
    input: z.object({ query: project }),
  },
  save_project: {
    title: 'Save project',
    description: 'Create a project (name), or update one (id). Its issue-id key comes from the name at creation and never changes. Example: save_project({ name: "Website", description: "Marketing site" })',
    input: z.object({
      id: z.string().optional().describe('Slug of the project to update; omit to create.'),
      name: z.string().min(1).optional().describe('Required to create; on update it renames.'),
      description: z.string().optional().describe('Markdown; replaces the current description.'),
      state: z.string().optional().describe('Project status, e.g. Planned, Active, Completed.'),
      baseDescription: z.string().optional().describe('The text you edited from; the save is refused if it changed since.'),
    }),
  },
  list_milestones: {
    title: 'List milestones', readOnly: true,
    description: 'A project\'s milestones with target dates and progress. Example: list_milestones({ project: "Website" })',
    input: z.object({ project }),
  },
  save_milestone: {
    title: 'Save milestone', idempotent: true,
    description: 'Create a milestone in a project, or update the one with that name. Only for a release or date the user named; assign issues with save_issue\'s milestone. Example: save_milestone({ project: "Website", name: "Beta", targetDate: "2027-02-01" })',
    input: z.object({
      project,
      name: z.string().min(1).describe('Milestone name; matches an existing one case-insensitively.'),
      description: z.string().optional().describe('Markdown.'),
      targetDate: z.string().optional().describe('YYYY-MM-DD.'),
    }),
  },
  get_document: {
    title: 'Get document', readOnly: true,
    description: 'A project document by id or exact title (get_project lists a project\'s documents). Example: get_document({ id: "website/architecture" })',
    input: z.object({ id: z.string().min(1).describe('Document id "<project>/<doc>", or its title.') }),
  },
  save_document: {
    title: 'Save document',
    description: 'Create a markdown document in a project, or replace one by id. Example: save_document({ project: "Website", title: "Architecture", content: "# Overview" })',
    input: z.object({
      project,
      title: z.string().min(1).describe('Document title.'),
      content: z.string().describe('Markdown; replaces the whole document.'),
      id: z.string().optional().describe('Document id "<project>/<doc>" to replace; omit to create.'),
      baseContent: z.string().optional().describe('The text you edited from; the save is refused if it changed since.'),
    }),
  },

  // ----- labels, statuses, keys -----
  list_issue_statuses: {
    title: 'List statuses', readOnly: true,
    description: 'The statuses save_issue\'s state accepts, with their type (backlog, unstarted, started, completed, canceled, duplicate).',
    input: z.object({}),
  },
  list_issue_labels: {
    title: 'List labels', readOnly: true,
    description: 'All labels; grouped ones have full names like "Scope/Web".',
    input: z.object({}),
  },
  save_issue_label: {
    title: 'Save label', idempotent: true,
    description: 'Create a label in a group, or change a label\'s color. save_issue creates plain labels on the fly, so use this only for groups or colors. Example: save_issue_label({ name: "Web", parent: "Scope" })',
    input: z.object({
      name: z.string().min(1).describe('Label name, or the full "Group/Name".'),
      color: z.string().optional().describe('Hex color, e.g. "#4ea7fc".'),
      parent: z.string().optional().describe('Group name; the label becomes "<parent>/<name>".'),
    }),
  },
  list_teams: {
    title: 'List ID prefixes (teams)', readOnly: true,
    description: 'Issue-id keys (e.g. "ENG") and the projects using each. Projects are the main unit; prefer list_projects.',
    input: z.object({}),
  },

  // ----- owner only (the app's UI; never listed to agents) -----
  delete_issue: {
    title: 'Delete issue',
    description: 'Delete an issue (owner only, from the UI). Agents cancel instead: save_issue({ id, state: "Canceled", comment }).',
    input: z.object({ id }),
  },
  save_view: {
    title: 'Save view',
    description: 'Save a view (filter + display options) to views/<slug>.yml. Owner only (the UI); agents are refused.',
    input: z.object({
      name: z.string().min(1), filter, display,
      slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional().describe('Update this existing view file. Without it a new view is created (refused if the name\'s slug is taken).'),
      favorite: z.boolean().optional().describe('Pin the view in the sidebar. Omitted on update: kept.'),
    }),
  },
} satisfies Record<string, ToolSchema>

export type ToolName = keyof typeof defs
/** Parsed arguments of a tool. */
export type ToolArgs<K extends ToolName> = z.infer<(typeof defs)[K]['input']>
export const toolSchemas: Record<string, ToolSchema> = defs

/** Owner-only tools: the app's UI has them, agents never see them. */
export const OWNER_ONLY: ReadonlySet<string> = new Set(['delete_issue', 'save_view'])

export type SaveIssueArgs = z.infer<typeof saveIssue>
export type BatchItemArgs = z.infer<typeof batchItem>
