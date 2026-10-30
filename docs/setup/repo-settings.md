# GitHub repo settings

The settings for `altoption/ai-task-tracking`, as commands, so they can be applied and re-applied exactly. Run
them as the repo owner (`gh auth status`) once the repo exists and the first CI run has finished on `main`. For a
fork or another owner, set `REPO` to that `owner/name`.

```sh
REPO=altoption/ai-task-tracking
```

## Merge settings
Squash or rebase merges only (linear history, no merge commits), and branches are deleted after merging:

```sh
gh api -X PATCH "repos/$REPO" \
  -F allow_merge_commit=false \
  -F allow_squash_merge=true \
  -F allow_rebase_merge=true \
  -F delete_branch_on_merge=true
```

## Branch protection for `main`
Requires a PR, requires the CI jobs `check` and `check-app` to pass on a branch that is up to date with `main`,
requires linear history, and blocks force-pushes and deletion. `required_approving_review_count` is 0 so a single
owner can merge alone; raise it to 1 once someone else reviews (GitHub never counts the author's own approval).

```sh
gh api -X PUT "repos/$REPO/branches/main/protection" \
  -H "Accept: application/vnd.github+json" --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "checks": [{ "context": "check" }, { "context": "check-app" }]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 0
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
```

Check it: `gh api "repos/$REPO/branches/main/protection" --jq '{reviews: .required_pull_request_reviews.required_approving_review_count, checks: [.required_status_checks.checks[].context], history: .required_linear_history.enabled, admins: .enforce_admins.enabled}'`.

## Notes
- The check names are the job names in `.github/workflows/ci.yml`. Rename a job there and update the command here,
  or PRs wait forever for a check that no longer runs.
- Branch protection on a private repo needs a paid GitHub plan (GitHub Pro for a personal account); the PUT fails
  with a 403 otherwise. Without it, the merge settings above still apply and the rules in CONTRIBUTING.md are kept
  by hand.
- With `enforce_admins: false` the owner can still push to `main` in an emergency. Set it to `true` to hold the owner
  to the same rules.
- `CODEOWNERS` (`.github/CODEOWNERS`) requests reviews from the owners automatically. To make a code owner's
  approval mandatory, set `require_code_owner_reviews` to `true`.
