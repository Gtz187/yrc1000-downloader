# Changelog

All notable changes to this extension are documented here.

## 1.3.1

- The automatic reference read starts with `JOB` and logs its start and result.
- A single unreadable file no longer aborts the reference read.
- The log shows the number of stored references and changed files, so missing badges can be diagnosed.

## 1.3.0

- **Changed files at a glance.** The extension remembers what was on the controller at the last download, upload or check. Changed files get a badge in the Explorer, the editor tabs and the controller view: **M** changed locally, **R** changed on the controller, **!** both, **U** only local. The robot icon in the activity bar shows the number of changed files.
- New command **Show Changed Files**: lists all differences and opens the diff of the picked file.
- Files downloaded with an older version have no reference yet. It is read automatically in the background (read-only) as soon as the controller is reachable without a password prompt.
- New command **Check with Robot…**: reads the chosen controller folders (read-only) and takes them as the new reference.
- Changes on the controller are detected by the date in the FTP listing (the YRC1000 reports no file sizes).

## 1.2.0

- **Safe upload.** Before a file is replaced, the current version is backed up from the controller. If the controller rejects the new file (e.g. `451 Error closing file.--[5110]--` for a job with a syntax error), it deletes the file. The extension now writes the original back automatically and explains what happened.
- When several files are uploaded, the upload stops at the first rejected file.
- New command **Open Upload Backups**. The last 50 uploads per controller are kept.

## 1.1.0

- Optional `password` in a controller entry of `settings.json`. If set, it takes precedence over the secret storage.

## 1.0.1

- The extension now starts with VS Code, so the status bar and the controller view are ready right away.

## 1.0.0

- Remote view with its own activity bar entry: browse the controller, open files read-only, download files or folders.
- Multiple controllers per workspace, a guided setup, and switching via the status bar.
- Upload from the Explorer, the editor tab or the editor context menu, with a confirmation dialog.
- Compare a local file with the controller version in the diff editor.
- Optional upload on save.
- Syntax highlighting for INFORM jobs (`.JBI`).
- Passwords are kept in the VS Code secret storage.
- English and German user interface.
- Built-in FTP client that understands the non-standard YRC1000 directory listing.
