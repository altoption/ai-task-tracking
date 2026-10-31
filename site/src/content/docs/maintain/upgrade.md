---
title: Upgrade
description: Upgrading is running the installer again.
sidebar:
  order: 1
---

Run the [install command](/docs/start/install/#one-line-install) again. It checks that the new build runs, quits the
app, replaces it and runs setup; your data folder and settings stay, Launch at Login is left as you set it, and the app
is reopened only if it was running. If the swap fails or is interrupted, the old app goes back in place.
`--version <tag>` installs a specific release.

Restart agent sessions afterwards.
