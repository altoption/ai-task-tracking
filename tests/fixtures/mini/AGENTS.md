# AI Task Tracking rules

This is the owner's issue tracker.

- Before starting work, call `whats_next` or `get_issue`.
- Give every issue a project, one `Scope/*` label and one type label (Bug, Feature, Improvement or Task).
- For multi-step work, create an epic with one child per step, all in one `save_issues` call.
- Record dependencies as `blockedBy`. Never leave them only in prose.
- Comment on every status change: say what shipped (PR or commit links) or what the issue waits on, with the date.
- Put decisions under a "Decided" heading in the description.
- Never delete an issue. Cancel it instead.
- Your repo and branch are recorded automatically.
