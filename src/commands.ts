import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Cancelled, Controller, ControllerService, UserError } from './controllers';
import { FtpClient } from './ftp';
import { BackupFailedError, SaveBackup, safeUploadAll, UploadRejectedError } from './safeUpload';
import { localPathFor, remoteUri, RemoteNode, RemoteTree, sortEntries } from './tree';

const t = vscode.l10n.t;

/** Number of upload backups kept per controller. */
const BACKUPS_KEPT = 50;

interface Transfer {
    local: string;
    dir: string;
    name: string;
}

export class Commands {
    constructor(
        private readonly service: ControllerService,
        private readonly tree: RemoteTree,
        private readonly log: vscode.LogOutputChannel,
        private readonly backupRoot: string,
    ) {}

    // ------------------------------------------------------------ controllers

    async addController(): Promise<void> {
        if (!this.service.workspaceRoot) {
            throw new UserError(t('Open a folder first. Robot files are stored in the workspace.'));
        }
        const existing = this.service.list();
        const steps = 4;
        const title = (n: number) => t('Add Robot Controller ({0}/{1})', n, steps);

        const name = await input({
            title: title(1),
            prompt: t('Display name, e.g. the cell or robot number'),
            value: existing.length ? t('Robot {0}', existing.length + 1) : t('Robot 1'),
            validateInput: (v) =>
                !v.trim() ? t('Please enter a name.') : existing.some((c) => c.name === v.trim()) ? t('This name is already used.') : undefined,
        });
        const host = await input({
            title: title(2),
            prompt: t('IP address of the YRC1000 controller'),
            placeHolder: '192.168.255.1',
            validateInput: (v) => (/^[\w.-]+$/.test(v.trim()) ? undefined : t('Please enter an IP address or host name.')),
        });
        const username = await input({
            title: title(3),
            prompt: t('FTP user configured on the controller'),
            validateInput: (v) => (v.trim() ? undefined : t('Please enter a user name.')),
        });
        const password = await input({ title: title(4), prompt: t('FTP password (stored in the VS Code secret storage)'), password: true });

        const raw = {
            name: name.trim(),
            host: host.trim(),
            username: username.trim(),
            // Several controllers in one workspace: give each its own subfolder.
            ...(existing.length ? { localFolder: name.trim().replace(/[\\/:*?"<>|]+/g, '_') } : {}),
        };
        await this.service.add(raw);
        const controller = this.service.requireActive();
        await this.service.storePassword(controller, password);
        await this.testConnection();
    }

    async switchController(): Promise<void> {
        const all = this.service.list();
        if (!all.length) {
            return this.addController();
        }
        const active = this.service.active;
        const addItem = { label: `$(add) ${t('Add Robot Controller…')}`, id: '__add__' };
        const pick = await vscode.window.showQuickPick(
            [
                ...all.map((c) => ({
                    label: `${c.name === active?.name ? '$(check)' : '$(blank)'} ${c.name}`,
                    description: `${c.username}@${c.host}`,
                    detail: path.relative(this.service.workspaceRoot!, c.localFolder) || t('workspace root'),
                    id: c.name,
                })),
                { label: '', kind: vscode.QuickPickItemKind.Separator, id: '' },
                addItem,
            ],
            { title: t('Select Robot Controller'), placeHolder: t('Active: {0}', active?.name ?? '–') },
        );
        if (!pick) {
            return;
        }
        if (pick.id === '__add__') {
            return this.addController();
        }
        await this.service.setActive(pick.id);
    }

    async removeController(): Promise<void> {
        const all = this.service.list();
        const pick = await vscode.window.showQuickPick(
            all.map((c) => ({ label: c.name, description: c.host, controller: c })),
            { title: t('Remove Robot Controller') },
        );
        if (!pick) {
            return;
        }
        await confirm(t('Remove "{0}"?', pick.label), t('Local files are kept.'), t('Remove'));
        await this.service.clearPassword(pick.controller);
        if (!(await this.service.remove(pick.label))) {
            throw new UserError(t('"{0}" is not defined in the workspace settings. Please remove it in your user settings.', pick.label), 'settings');
        }
    }

    async testConnection(): Promise<void> {
        const c = this.service.requireActive();
        const entries = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('Connecting to {0}…', c.host) },
            () => this.service.run((client) => client.list('')),
        );
        const dirs = sortEntries(entries)
            .filter((e) => e.isDir)
            .map((e) => e.name);
        void vscode.window.showInformationMessage(t('Connected to {0} ({1}). Folders: {2}', c.name, c.host, dirs.join(', ') || '–'));
        this.tree.refresh();
    }

    async setPassword(): Promise<void> {
        const c = this.service.requireActive();
        if (c.password !== undefined) {
            throw new UserError(t('The password of "{0}" is set in settings.json and takes precedence. Change it there.', c.name), 'settings');
        }
        await this.service.getPassword(c, true);
        void vscode.window.showInformationMessage(t('Password for {0} saved.', c.name));
        this.tree.refresh();
    }

    async clearPassword(): Promise<void> {
        const c = this.service.requireActive();
        await this.service.clearPassword(c);
        void vscode.window.showInformationMessage(t('Stored password for {0} removed.', c.name));
    }

    // --------------------------------------------------------------- download

    async downloadConfigured(): Promise<void> {
        const c = this.service.requireActive();
        if (!c.downloadFolders.length) {
            return this.downloadSelected();
        }
        await this.downloadFolders(c, c.downloadFolders);
    }

    async downloadSelected(): Promise<void> {
        const c = this.service.requireActive();
        const entries = await this.service.run((client) => client.list(''));
        const picks = sortEntries(entries)
            .filter((e) => e.isDir)
            .map((e) => ({ label: e.name, description: folderInfo(e.name), picked: c.downloadFolders.includes(e.name) }));
        const chosen = await vscode.window.showQuickPick(picks, { canPickMany: true, title: t('Download folders from {0}', c.name) });
        if (chosen?.length) {
            await this.downloadFolders(c, chosen.map((p) => p.label));
        }
    }

    async downloadItem(node?: RemoteNode, nodes?: RemoteNode[]): Promise<void> {
        const selection = nodes?.length ? nodes : node ? [node] : this.tree.view.selection;
        if (!selection.length) {
            return this.downloadSelected();
        }
        const c = this.service.requireActive();
        const dirs = selection.filter((n) => n.isDir).map((n) => n.remotePath);
        const files = selection.filter((n) => !n.isDir);
        if (dirs.length) {
            await this.downloadFolders(c, dirs);
        }
        if (files.length) {
            const plan = files.map((n) => ({ dir: n.dir, name: n.name, local: localPathFor(c, n.dir, n.name) }));
            const existing = plan.filter((p) => fs.existsSync(p.local));
            if (existing.length) {
                await confirm(
                    t('Overwrite {0} local file(s)?', existing.length),
                    listOf(existing.map((p) => `${p.dir}/${p.name}`)),
                    t('Download'),
                );
            }
            const count = await this.transfer(t('Downloading from {0}', c.name), plan, async (client, p) => {
                await fs.promises.mkdir(path.dirname(p.local), { recursive: true });
                await client.download(p.dir, p.name, p.local);
            });
            this.done(t('{0} file(s) downloaded.', count), plan.length === 1 ? plan[0].local : undefined);
        }
    }

    private async downloadFolders(c: Controller, dirs: string[]): Promise<void> {
        const nonEmpty = dirs.filter((d) => {
            const p = path.join(c.localFolder, ...d.split('/'));
            return fs.existsSync(p) && fs.readdirSync(p).length > 0;
        });
        if (nonEmpty.length) {
            await confirm(
                t('Download {0} from {1}?', dirs.join(', '), c.name),
                t('Local files with the same name in {0} will be overwritten.', nonEmpty.join(', ')),
                t('Download'),
            );
        }
        const plan = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('Reading folder list…') },
            () =>
                this.service.run(async (client) => {
                    const items: Transfer[] = [];
                    for (const dir of dirs) {
                        const files = (await client.list(dir)).filter((e) => !e.isDir);
                        items.push(...files.map((f) => ({ dir, name: f.name, local: localPathFor(c, dir, f.name) })));
                    }
                    return items;
                }),
        );
        for (const dir of dirs) {
            await fs.promises.mkdir(path.join(c.localFolder, ...dir.split('/')), { recursive: true });
        }
        const count = await this.transfer(t('Downloading from {0}', c.name), plan, (client, p) => client.download(p.dir, p.name, p.local));
        this.done(t('{0} file(s) downloaded from {1}.', count, dirs.join(', ')));
    }

    async openRemoteFile(node: RemoteNode): Promise<void> {
        const c = this.service.requireActive();
        await vscode.window.showTextDocument(remoteUri(c, node.dir, node.name, true), { preview: true });
    }

    // ----------------------------------------------------------------- upload

    async upload(uri?: vscode.Uri, uris?: vscode.Uri[]): Promise<void> {
        const c = this.service.requireActive();
        const selected = uris?.length ? uris : uri ? [uri] : activeFileUri();
        if (!selected.length) {
            throw new UserError(t('Select a local file or folder to upload.'));
        }

        const files: string[] = [];
        for (const u of selected) {
            if (u.scheme !== 'file') {
                throw new UserError(t('Only local files can be uploaded.'));
            }
            const stat = await fs.promises.stat(u.fsPath);
            if (stat.isDirectory()) {
                for (const e of await fs.promises.readdir(u.fsPath, { withFileTypes: true })) {
                    if (e.isFile() && !e.name.startsWith('.') && !e.name.endsWith('.yrcpart')) {
                        files.push(path.join(u.fsPath, e.name));
                    }
                }
            } else {
                files.push(u.fsPath);
            }
        }
        if (!files.length) {
            throw new UserError(t('The selected folder contains no files.'));
        }
        await saveDirty(files);

        const plan: Transfer[] = [];
        let askedDir: string | undefined;
        for (const local of files) {
            const target = remoteTargetOf(c, local);
            if (target === undefined) {
                throw new UserError(t('{0} is outside the local folder of "{1}" ({2}).', path.basename(local), c.name, c.localFolder), 'settings');
            }
            let dir = target.dir;
            if (!dir) {
                askedDir ??= await this.pickRemoteDir(c);
                dir = askedDir;
            }
            plan.push({ local, dir, name: target.name });
        }

        if (vscode.workspace.getConfiguration('yrc1000').get<boolean>('confirmUpload', true)) {
            await confirm(
                t('Upload {0} file(s) to {1}?', plan.length, `${c.name} (${c.host})`),
                t('Existing files on the controller will be overwritten.') + '\n\n' + listOf(plan.map((p) => `${p.dir}/${p.name}`)),
                t('Upload'),
            );
        }

        const count = await this.uploadSafely(c, plan, false);
        this.done(t('{0} file(s) uploaded to {1}.', count, c.name));
    }

    /** Silent upload used by "upload on save". */
    async uploadOnSave(doc: vscode.TextDocument): Promise<void> {
        const c = this.service.active;
        if (!c || doc.uri.scheme !== 'file') {
            return;
        }
        const target = remoteTargetOf(c, doc.uri.fsPath);
        if (!target?.dir) {
            return;
        }
        await this.uploadSafely(c, [{ local: doc.uri.fsPath, ...target }], true);
        this.tree.refresh();
        vscode.window.setStatusBarMessage(`$(cloud-upload) ${t('{0} uploaded to {1}', `${target.dir}/${target.name}`, c.name)}`, 4000);
    }

    /**
     * Backs up every file from the controller before replacing it and restores it
     * automatically if the controller rejects the new version.
     */
    private async uploadSafely(c: Controller, plan: Transfer[], silent: boolean): Promise<number> {
        const folder = path.join(this.backupRoot, safeFileName(c.name), timestamp());
        const save: SaveBackup = async (dir, name, content) => {
            const file = path.join(folder, ...dir.split('/'), name);
            await fs.promises.mkdir(path.dirname(file), { recursive: true });
            await fs.promises.writeFile(file, content);
            this.log.info(`Backup of ${dir}/${name} saved to ${file}`);
            return file;
        };
        const run = (progress?: vscode.Progress<{ message?: string; increment?: number }>, token?: vscode.CancellationToken) =>
            this.service.run((client) =>
                safeUploadAll(
                    client,
                    plan,
                    save,
                    (p, i) => progress?.report({ message: `${p.dir}/${p.name} (${i + 1}/${plan.length})`, increment: 100 / plan.length }),
                    () => !!token?.isCancellationRequested,
                ),
            );

        try {
            const results = silent
                ? await run()
                : await vscode.window.withProgress(
                      { location: vscode.ProgressLocation.Notification, title: t('Uploading to {0}', c.name), cancellable: true },
                      (progress, token) => run(progress, token),
                  );
            this.log.info(`Uploaded ${results.length} file(s) to ${c.name}`);
            return results.length;
        } catch (err) {
            if (err instanceof UploadRejectedError) {
                await this.handleRejected(c, err, plan);
            }
            if (err instanceof BackupFailedError) {
                this.log.error(`Backup failed: ${err.message}`);
                throw new UserError(
                    t('{0} could not be backed up from the controller, so it was not uploaded. {1}', `${err.item.dir}/${err.item.name}`, errorText(err.cause)),
                );
            }
            throw err;
        } finally {
            this.tree.refresh();
            void this.pruneBackups(c);
        }
    }

    private async handleRejected(c: Controller, err: UploadRejectedError, plan: Transfer[]): Promise<never> {
        const file = `${err.item.dir}/${err.item.name}`;
        let outcome = err.outcome;

        // The first restore attempt failed (e.g. lost connection): try once more on a new connection.
        if (outcome === 'restoreFailed' && err.backupFile) {
            try {
                const content = await fs.promises.readFile(err.backupFile);
                await this.service.run((client) => client.write(err.item.dir, err.item.name, content));
                outcome = 'restored';
            } catch (retryErr) {
                this.log.error(`Restoring ${file} failed again: ${errorText(retryErr)}`);
            }
        }

        this.log.error(`Controller rejected ${file}: ${errorText(err.cause)} → ${outcome}${err.backupFile ? ` (backup: ${err.backupFile})` : ''}`);

        const index = plan.findIndex((p) => p.dir === err.item.dir && p.name === err.item.name);
        const reason = err.controllerCode
            ? t('Controller message: {0} (error {1})', err.controllerMessage, err.controllerCode)
            : t('Controller message: {0}', err.controllerMessage || errorText(err.cause));
        const rest =
            plan.length > 1
                ? '\n\n' + t('{0} file(s) before it were uploaded, {1} file(s) after it were not uploaded.', Math.max(index, 0), plan.length - index - 1)
                : '';

        const compare = t('Compare with Robot');
        const openBackup = t('Open Backup');
        const showLog = t('Show Log');
        let message: string;
        let detail: string;
        let actions: string[];
        switch (outcome) {
            case 'restored':
                message = t('The controller rejected {0}. The original version was restored.', file);
                detail = `${reason}\n\n${t('Check the file for errors, e.g. the job syntax, and upload it again.')}${rest}`;
                actions = [compare, showLog];
                break;
            case 'newFile':
                message = t('The controller rejected {0}.', file);
                detail = `${reason}\n\n${t('The file did not exist on the controller before, so there was nothing to restore.')}${rest}`;
                actions = [showLog];
                break;
            default:
                message = t('The controller rejected {0} and the original could NOT be restored!', file);
                detail = `${reason}\n\n${t('The original is saved here. Upload it again manually:')}\n${err.backupFile}${rest}`;
                actions = [openBackup, showLog];
        }

        const choice = await vscode.window.showErrorMessage(message, { modal: true, detail }, ...actions);
        if (choice === compare) {
            await this.compare(vscode.Uri.file(err.item.local));
        } else if (choice === openBackup && err.backupFile) {
            await vscode.env.openExternal(vscode.Uri.file(path.dirname(err.backupFile)));
        } else if (choice === showLog) {
            this.log.show();
        }
        throw new Cancelled();
    }

    async openBackups(): Promise<void> {
        const c = this.service.requireActive();
        const folder = path.join(this.backupRoot, safeFileName(c.name));
        await fs.promises.mkdir(folder, { recursive: true });
        await vscode.env.openExternal(vscode.Uri.file(folder));
    }

    private async pruneBackups(c: Controller): Promise<void> {
        try {
            const folder = path.join(this.backupRoot, safeFileName(c.name));
            const entries = (await fs.promises.readdir(folder, { withFileTypes: true }))
                .filter((e) => e.isDirectory())
                .map((e) => e.name)
                .sort()
                .reverse();
            for (const old of entries.slice(BACKUPS_KEPT)) {
                await fs.promises.rm(path.join(folder, old), { recursive: true, force: true });
            }
        } catch {
            // no backups yet
        }
    }

    private async pickRemoteDir(c: Controller): Promise<string> {
        const entries = await this.service.run((client) => client.list(''));
        const pick = await vscode.window.showQuickPick(
            sortEntries(entries)
                .filter((e) => e.isDir)
                .map((e) => ({ label: e.name, description: folderInfo(e.name) })),
            { title: t('Target folder on {0}', c.name), placeHolder: t('The file is not inside a controller folder (JOB, DAT, …). Where should it go?') },
        );
        if (!pick) {
            throw new Cancelled();
        }
        return pick.label;
    }

    // ---------------------------------------------------------------- compare

    async compare(arg?: vscode.Uri | RemoteNode): Promise<void> {
        const c = this.service.requireActive();
        let dir: string;
        let name: string;
        let local: string;
        if (arg instanceof RemoteNode) {
            dir = arg.dir;
            name = arg.name;
            local = localPathFor(c, dir, name);
        } else {
            const uri = arg ?? activeFileUri()[0];
            if (!uri || uri.scheme !== 'file') {
                throw new UserError(t('Select a local file to compare.'));
            }
            const target = remoteTargetOf(c, uri.fsPath);
            if (!target?.dir) {
                throw new UserError(t('{0} is not inside a controller folder of "{1}".', path.basename(uri.fsPath), c.name));
            }
            ({ dir, name } = target);
            local = uri.fsPath;
        }
        if (!fs.existsSync(local)) {
            throw new UserError(t('There is no local copy of {0} yet. Download it first.', `${dir}/${name}`));
        }
        await vscode.commands.executeCommand(
            'vscode.diff',
            remoteUri(c, dir, name, true),
            vscode.Uri.file(local),
            t('{0} ({1} ↔ local)', name, c.name),
        );
    }

    // ---------------------------------------------------------------- helpers

    private async transfer(title: string, plan: Transfer[], step: (client: FtpClient, p: Transfer) => Promise<void>): Promise<number> {
        if (!plan.length) {
            return 0;
        }
        const started = Date.now();
        const count = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title, cancellable: true },
            (progress, token) =>
                this.service.run(async (client) => {
                    let done = 0;
                    for (const p of plan) {
                        if (token.isCancellationRequested) {
                            throw new Cancelled();
                        }
                        progress.report({ message: `${p.dir}/${p.name} (${done + 1}/${plan.length})`, increment: 100 / plan.length });
                        await step(client, p);
                        done++;
                    }
                    return done;
                }),
        );
        this.log.info(`${title}: ${count} file(s) in ${((Date.now() - started) / 1000).toFixed(1)} s`);
        return count;
    }

    private done(message: string, openFile?: string): void {
        this.tree.refresh();
        const open = t('Open');
        void vscode.window.showInformationMessage(message, ...(openFile ? [open] : [])).then((a) => {
            if (a === open && openFile) {
                void vscode.window.showTextDocument(vscode.Uri.file(openFile));
            }
        });
    }
}

// --------------------------------------------------------------------- utils

function folderInfo(name: string): string | undefined {
    const info: Record<string, string> = {
        JOB: t('Jobs (*.JBI)'),
        DAT: t('Variables, tool and user frames'),
        CND: t('Conditions'),
        SYS: t('System information'),
        PRM: t('Parameters'),
        LST: t('Lists'),
        CSV: t('CSV data'),
        LOG: t('Logs and alarms'),
        TXT: t('Text files'),
    };
    return info[name.toUpperCase()];
}

/** Maps a local file to its place on the controller, e.g. <local>/JOB/A.JBI → { dir: "JOB", name: "A.JBI" }. */
export function remoteTargetOf(c: Controller, file: string): { dir: string; name: string } | undefined {
    const rel = path.relative(c.localFolder, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        return undefined;
    }
    const parts = rel.split(path.sep);
    // Never map hidden folders or files (.vscode, .git, …) to the controller.
    if (parts.some((p) => p.startsWith('.'))) {
        return undefined;
    }
    const name = parts.pop()!;
    return { dir: parts.join('/'), name };
}

function safeFileName(name: string): string {
    return name.replace(/[\\/:*?"<>|]+/g, '_');
}

/** Sortable local time stamp, e.g. 2026-11-05_08-45-30. */
function timestamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function activeFileUri(): vscode.Uri[] {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return uri ? [uri] : [];
}

async function saveDirty(files: string[]): Promise<void> {
    const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
    const wanted = new Set(files.map(norm));
    for (const doc of vscode.workspace.textDocuments) {
        if (doc.isDirty && wanted.has(norm(doc.uri.fsPath))) {
            await doc.save();
        }
    }
}

async function input(options: vscode.InputBoxOptions): Promise<string> {
    const value = await vscode.window.showInputBox({ ignoreFocusOut: true, ...options });
    if (value === undefined) {
        throw new Cancelled();
    }
    return value;
}

async function confirm(message: string, detail: string, action: string): Promise<void> {
    const answer = await vscode.window.showWarningMessage(message, { modal: true, detail }, action);
    if (answer !== action) {
        throw new Cancelled();
    }
}

function listOf(names: string[], max = 12): string {
    return names.length > max ? `${names.slice(0, max).join('\n')}\n${t('… and {0} more', names.length - max)}` : names.join('\n');
}
