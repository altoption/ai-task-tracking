---
title: Backup
description: Automatic git commits, pushing to a private GitHub repo, and restoring on another Mac.
sidebar:
  order: 3
---

The data folder is a git repo. The app commits every change a couple of seconds after it happens.

With a backup repo (setup step 4, or `aitt setup --backup <owner/name>`), it also pushes:

- five minutes after the last change;
- on **Back Up Now** in the menu;
- before quitting (**Settings ▸ Back up to GitHub before quitting**).

The menu shows the backup status: backed up, changes waiting, or a problem. If a backup fails, see
[Troubleshooting](/docs/maintain/troubleshooting/).

## Restore on another Mac

Clone the backup repo, then install with the clone as the data folder:

```sh
git clone <backup repo> ~/AITaskTracking
```

Then run the [installer](/docs/start/install/) with `AITT_HOME=~/AITaskTracking`.
