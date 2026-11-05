# Changelog

All notable changes to this extension are documented here.

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
