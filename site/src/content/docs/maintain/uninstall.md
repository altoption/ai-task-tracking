---
title: Uninstall
description: Remove the app and its agent connections; your data folder is kept.
sidebar:
  order: 2
---

```sh
curl -fsSL https://raw.githubusercontent.com/altoption/ai-task-tracking/HEAD/uninstall.sh | bash
```

Use `bash -s -- --yes` instead of `bash` to skip the question. From a clone, `./uninstall.sh [--yes]`; or run
`aitt uninstall [--yes]` directly.

It quits the app, then removes:

- the app and its login item;
- the MCP entries (Claude Code and the other agent tools) and the `~/.local/bin/aitt` link that run *this* app;
- the agent skill and the `CLAUDE.md` line, unless another install of AI Task Tracking stays registered.

`AITT_APP_DIR=<dir>` picks an app installed elsewhere.

:::note[Your data folder is kept]
The output says where it is so you can delete it yourself.
:::
