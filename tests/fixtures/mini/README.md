# Fixture: mini

A small tracker folder reused by tests. Later tasks assert these exact ids.

- `config.yml`: default 7 statuses, `nextNumber: {Q: 7}`, `workspaces: {web-app: support}`.
- `labels.yml`: Bug/Feature/Improvement/Task, `Needs decision`, `Blocked`, groups `Scope/*` (App, Support, Platform) and `Env/*` (Prod, Staging).
- Projects (both key `Q`):
  - `support`: Q-5, Q-6
  - `acme-app`: Q-1..Q-4, milestones `MVP` and `Beta`, doc `architecture` ("Architecture notes")

| Id  | Project         | Status      | Pri | Notes                          |
|-----|-----------------|-------------|-----|--------------------------------|
| Q-1 | acme-app | In Progress | 2   | root of tree, milestone MVP, plan now |
| Q-2 | acme-app | Todo        | 3   | parent Q-1                     |
| Q-3 | acme-app | Todo        | 1   | parent Q-2 (3 deep)            |
| Q-4 | acme-app | Backlog     | 4   | `blocked_by: [Q-3]`            |
| Q-5 | support         | Waiting     | 2   | needs-you status               |
| Q-6 | support         | Done        | 0   | completed                      |
