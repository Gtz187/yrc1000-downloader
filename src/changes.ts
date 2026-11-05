import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Cancelled, Controller, ControllerService } from './controllers';
import { FtpError, RemoteEntry } from './ftp';
import { Baseline, ChangeStatus, classify, fileKey, hashContent } from './syncLogic';
import { localPathFor, remoteTargetOf } from './tree';

const t = vscode.l10n.t;

const STATE_PREFIX = 'yrc1000.baselines:';
const SAVE_DELAY_MS = 500;
const REFRESH_DELAY_MS = 150;

export interface ChangedFile {
    dir: string;
    name: string;
    local: string;
    status: ChangeStatus;
}

/** Folder listing: upper-case file name → listing date (undefined if the server sent none). */
type Listing = Map<string, string | undefined>;

/**
 * Remembers what was on the controller at the last download, upload or check ("baseline")
 * and decorates changed files in the Explorer, the editor tabs and the controller view.
 */
export class ChangeTracker implements vscode.FileDecorationProvider, vscode.Disposable {
    private readonly decorationsChanged = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations = this.decorationsChanged.event;
    private readonly summaryChanged = new vscode.EventEmitter<ChangedFile[]>();
    /** Fires with the current list of changed files of the active controller. */
    readonly onDidChangeSummary = this.summaryChanged.event;

    /** Per controller: file key → baseline. Loaded lazily from the workspace state. */
    private readonly baselines = new Map<string, Map<string, Baseline>>();
    /** Per controller: upper-case folder → latest listing. */
    private readonly listings = new Map<string, Map<string, Listing>>();
    private readonly hashes = new Map<string, { mtime: number; size: number; hash: string }>();
    private readonly unsaved = new Set<string>();
    private saveTimer: NodeJS.Timeout | undefined;
    private refreshTimer: NodeJS.Timeout | undefined;
    private watcher: vscode.FileSystemWatcher | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    /** Controllers for which the automatic reference read was already started in this session. */
    private readonly autoStarted = new Set<string>();
    private lastCount = -1;
    private decorationLogged = false;

    constructor(
        private readonly ctx: vscode.ExtensionContext,
        private readonly service: ControllerService,
        private readonly log: vscode.LogOutputChannel,
    ) {
        this.disposables.push(
            this.decorationsChanged,
            this.summaryChanged,
            service.onDidChange(() => {
                this.watch();
                void this.startAutoReference(false);
            }),
        );
        this.watch();
        void this.startAutoReference(false);
    }

    /**
     * Files downloaded before change tracking existed have no baseline and therefore no badge.
     * Reads their controller version once in the background (read-only) and takes it as the baseline.
     * @param mayPrompt false: only if the password is known, so VS Code never asks for it at startup.
     */
    async startAutoReference(mayPrompt: boolean): Promise<void> {
        const c = this.service.active;
        if (!c || !c.username || this.autoStarted.has(this.id(c))) {
            return;
        }
        if (!mayPrompt && !(await this.service.hasPassword(c))) {
            this.log.info(`Change tracking: no stored password for ${c.name}, reference is read after the first connection`);
            return;
        }
        if (this.autoStarted.has(this.id(c))) {
            return; // started by another call while waiting for the password check
        }
        this.autoStarted.add(this.id(c));
        // Jobs first: that is where changes matter most.
        const dirs = this.trackedDirs(c)
            .filter((d) => this.untrackedLocalFiles(c, d).length > 0)
            .sort((a, b) => Number(b.toUpperCase() === 'JOB') - Number(a.toUpperCase() === 'JOB'));
        this.log.info(
            `Change tracking: ${this.baselinesOf(c).size} reference(s) stored for ${c.name}; folders ${this.trackedDirs(c).join(', ') || '–'}; without reference: ${dirs.join(', ') || '–'}`,
        );
        if (!dirs.length) {
            return;
        }
        this.log.info(`Change tracking: reading reference from ${c.name} for files without one (${dirs.join(', ')})`);
        try {
            const count = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: t('Reading reference from {0}…', c.name) },
                (progress) => this.checkWithController(c, dirs, progress, new vscode.CancellationTokenSource().token, true),
            );
            this.log.info(`Change tracking: reference of ${count} file(s) read from ${c.name} (${dirs.join(', ')})`);
        } catch (err) {
            this.autoStarted.delete(this.id(c));
            if (!(err instanceof Cancelled)) {
                this.log.warn(`Change tracking: reading the reference from ${c.name} failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }

    private untrackedLocalFiles(c: Controller, dir: string): string[] {
        try {
            const baselines = this.baselinesOf(c);
            return fs
                .readdirSync(path.join(c.localFolder, ...dir.split('/')), { withFileTypes: true })
                .filter((e) => e.isFile() && !e.name.startsWith('.') && !e.name.endsWith('.yrcpart') && !baselines.has(fileKey(dir, e.name)))
                .map((e) => e.name);
        } catch {
            return [];
        }
    }

    dispose(): void {
        clearTimeout(this.refreshTimer);
        this.flush();
        this.watcher?.dispose();
        this.disposables.forEach((d) => d.dispose());
    }

    // -------------------------------------------------------------- baselines

    private id(c: Controller): string {
        return `${c.host}:${c.port}|${path.resolve(c.localFolder).toLowerCase()}`;
    }

    private baselinesOf(c: Controller): Map<string, Baseline> {
        const id = this.id(c);
        let map = this.baselines.get(id);
        if (!map) {
            map = new Map(Object.entries(this.ctx.workspaceState.get<Record<string, Baseline>>(STATE_PREFIX + id, {})));
            this.baselines.set(id, map);
        }
        return map;
    }

    /**
     * Records that the controller now holds exactly `content` (or the content of the local file).
     * @param stamp listing date on the controller; leave empty if not known, it is taken from the next listing.
     */
    async record(c: Controller, dir: string, name: string, content: Buffer | string, stamp?: string): Promise<void> {
        const buffer = typeof content === 'string' ? await fs.promises.readFile(content) : content;
        this.baselinesOf(c).set(fileKey(dir, name), { hash: hashContent(buffer), stamp });
        this.markUnsaved(c);
    }

    /** Stores a fresh folder listing of the controller. */
    noteListing(c: Controller, dir: string, entries: RemoteEntry[]): void {
        const listing: Listing = new Map(entries.filter((e) => !e.isDir).map((e) => [e.name.toUpperCase(), e.modified]));
        const id = this.id(c);
        if (!this.listings.has(id)) {
            this.listings.set(id, new Map());
        }
        this.listings.get(id)!.set(dir.toUpperCase(), listing);

        // Files uploaded by this extension get their controller date from the first listing after the upload.
        const baselines = this.baselinesOf(c);
        for (const [name, stamp] of listing) {
            const b = baselines.get(fileKey(dir, name));
            if (b && !b.stamp && stamp) {
                b.stamp = stamp;
                this.markUnsaved(c);
            }
        }
        this.scheduleRefresh();
        // The connection works now (password known): fetch missing references, if not done yet.
        void this.startAutoReference(false);
    }

    /** Lists the given controller folders to detect changes made on the controller. */
    async refreshRemote(c: Controller, dirs: string[]): Promise<void> {
        await this.service.run(async (client) => {
            for (const dir of dirs) {
                this.noteListing(c, dir, await client.list(dir));
            }
        }, c);
    }

    private markUnsaved(c: Controller): void {
        this.unsaved.add(this.id(c));
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
        this.scheduleRefresh();
    }

    private flush(): void {
        clearTimeout(this.saveTimer);
        for (const id of this.unsaved) {
            const map = this.baselines.get(id);
            if (map) {
                const size = map.size;
                this.ctx.workspaceState.update(STATE_PREFIX + id, Object.fromEntries(map)).then(
                    () => this.log.info(`Change tracking: ${size} reference(s) saved`),
                    (err: unknown) => this.log.error(`Change tracking: saving references failed: ${err instanceof Error ? err.message : String(err)}`),
                );
            }
        }
        this.unsaved.clear();
    }

    // ----------------------------------------------------------------- status

    private async localHash(file: string): Promise<string | undefined> {
        let stat: fs.Stats;
        try {
            stat = await fs.promises.stat(file);
        } catch {
            return undefined;
        }
        if (!stat.isFile()) {
            return undefined;
        }
        const key = path.resolve(file).toLowerCase();
        const cached = this.hashes.get(key);
        if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
            return cached.hash;
        }
        const hash = hashContent(await fs.promises.readFile(file));
        this.hashes.set(key, { mtime: stat.mtimeMs, size: stat.size, hash });
        return hash;
    }

    /** Listing date on the controller; null = not on the controller; undefined = folder not listed yet. */
    private remoteStamp(c: Controller, dir: string, name: string): string | null | undefined {
        const listing = this.listings.get(this.id(c))?.get(dir.toUpperCase());
        if (!listing) {
            return undefined;
        }
        return listing.has(name.toUpperCase()) ? listing.get(name.toUpperCase()) : null;
    }

    async statusOf(c: Controller, dir: string, name: string): Promise<ChangeStatus> {
        const localHash = await this.localHash(localPathFor(c, dir, name));
        return classify(localHash, this.remoteStamp(c, dir, name), this.baselinesOf(c).get(fileKey(dir, name)));
    }

    /** Controller folders that are worth looking at: tracked, listed or configured for download. */
    trackedDirs(c: Controller): string[] {
        const dirs = new Map<string, string>();
        const add = (d: string) => d && !dirs.has(d.toUpperCase()) && dirs.set(d.toUpperCase(), d);
        for (const key of this.baselinesOf(c).keys()) {
            add(key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '');
        }
        c.downloadFolders.forEach(add);
        return [...dirs.values()].filter((d) => fs.existsSync(path.join(c.localFolder, ...d.split('/'))));
    }

    /** All files of the active controller that changed locally or on the controller. */
    async changedFiles(c: Controller): Promise<ChangedFile[]> {
        const result: ChangedFile[] = [];
        const seen = new Set<string>();
        const check = async (dir: string, name: string) => {
            const key = fileKey(dir, name);
            if (seen.has(key)) {
                return;
            }
            seen.add(key);
            const status = await this.statusOf(c, dir, name);
            if (status !== 'clean' && status !== 'unknown') {
                result.push({ dir, name, local: localPathFor(c, dir, name), status });
            }
        };
        for (const dir of this.trackedDirs(c)) {
            let entries: fs.Dirent[] = [];
            try {
                entries = await fs.promises.readdir(path.join(c.localFolder, ...dir.split('/')), { withFileTypes: true });
            } catch {
                // folder gone
            }
            for (const e of entries) {
                if (e.isFile() && !e.name.startsWith('.') && !e.name.endsWith('.yrcpart')) {
                    await check(dir, e.name);
                }
            }
        }
        // Tracked files that only changed on the controller (or were deleted locally).
        for (const key of this.baselinesOf(c).keys()) {
            const i = key.lastIndexOf('/');
            const dir = i < 0 ? '' : key.slice(0, i);
            const name = key.slice(i + 1);
            if (this.remoteStamp(c, dir, name) && fs.existsSync(localPathFor(c, dir, name))) {
                await check(dir, name);
            }
        }
        return result.sort((a, b) => fileKey(a.dir, a.name).localeCompare(fileKey(b.dir, b.name), undefined, { numeric: true }));
    }

    /**
     * Reads the given controller files and takes them as the new baseline.
     * Used for files that were downloaded before change tracking existed.
     */
    async checkWithController(
        c: Controller,
        dirs: string[],
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        token: vscode.CancellationToken,
        onlyUntracked = false,
    ): Promise<number> {
        return this.service.run(async (client) => {
            const plan: { dir: string; name: string; stamp?: string }[] = [];
            const baselines = this.baselinesOf(c);
            for (const dir of dirs) {
                const entries = await client.list(dir);
                this.noteListing(c, dir, entries);
                for (const e of entries) {
                    if (onlyUntracked && baselines.has(fileKey(dir, e.name))) {
                        continue;
                    }
                    if (!e.isDir && fs.existsSync(localPathFor(c, dir, e.name))) {
                        plan.push({ dir, name: e.name, stamp: e.modified });
                    }
                }
            }
            let done = 0;
            for (const p of plan) {
                if (token.isCancellationRequested) {
                    throw new Cancelled();
                }
                progress.report({ message: `${p.dir}/${p.name} (${done + 1}/${plan.length})`, increment: 100 / plan.length });
                try {
                    await this.record(c, p.dir, p.name, await client.read(p.dir, p.name), p.stamp);
                    done++;
                } catch (err) {
                    // A single unreadable file must not stop the check; a lost connection must.
                    if (!(err instanceof FtpError) || err.connectionLost) {
                        throw err;
                    }
                    this.log.warn(`Change tracking: ${p.dir}/${p.name} could not be read: ${err.message}`);
                }
            }
            return done;
        }, c);
    }

    // ------------------------------------------------------------ decorations

    async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
        const c = this.service.active;
        if (!c) {
            return undefined;
        }
        let target: { dir: string; name: string } | undefined;
        if (uri.scheme === 'file') {
            target = remoteTargetOf(c, uri.fsPath);
        } else if (uri.scheme === 'yrc1000') {
            const parts = uri.path.split('/').filter(Boolean);
            const name = parts.pop();
            target = name ? { dir: parts.join('/'), name } : undefined;
        }
        if (!target?.dir) {
            return undefined;
        }
        const status = await this.statusOf(c, target.dir, target.name);
        if (!this.decorationLogged) {
            this.decorationLogged = true;
            this.log.info(`Change tracking: decorations active (first: ${target.dir}/${target.name} → ${status})`);
        }
        return decorationFor(status);
    }

    // --------------------------------------------------------------- refresh

    private watch(): void {
        this.watcher?.dispose();
        this.watcher = undefined;
        this.hashes.clear();
        const c = this.service.active;
        if (c) {
            this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(c.localFolder, '**/*'));
            const changed = () => this.scheduleRefresh();
            this.watcher.onDidChange(changed);
            this.watcher.onDidCreate(changed);
            this.watcher.onDidDelete(changed);
        }
        this.scheduleRefresh();
    }

    /** Re-evaluates all decorations and the summary (debounced). */
    scheduleRefresh(): void {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => {
            this.decorationsChanged.fire(undefined);
            const c = this.service.active;
            void (c ? this.changedFiles(c) : Promise.resolve([])).then(
                (files) => {
                    if (files.length !== this.lastCount) {
                        this.lastCount = files.length;
                        this.log.info(`Change tracking: ${files.length} changed file(s)`);
                    }
                    this.summaryChanged.fire(files);
                },
                (err: unknown) => this.log.error(`Change tracking: ${err instanceof Error ? err.message : String(err)}`),
            );
        }, REFRESH_DELAY_MS);
    }
}

export function statusText(status: ChangeStatus): string {
    switch (status) {
        case 'local':
            return t('Changed locally, not uploaded yet');
        case 'remote':
            return t('Changed on the controller since the last sync');
        case 'both':
            return t('Changed locally and on the controller');
        case 'localOnly':
            return t('Only local, not on the controller');
        default:
            return '';
    }
}

function decorationFor(status: ChangeStatus): vscode.FileDecoration | undefined {
    const deco = (badge: string, color: string) => {
        const d = new vscode.FileDecoration(badge, statusText(status), new vscode.ThemeColor(color));
        d.propagate = true;
        return d;
    };
    switch (status) {
        case 'local':
            return deco('M', 'gitDecoration.modifiedResourceForeground');
        case 'remote':
            return deco('R', 'charts.blue');
        case 'both':
            return deco('!', 'gitDecoration.conflictingResourceForeground');
        case 'localOnly':
            return deco('U', 'gitDecoration.untrackedResourceForeground');
        default:
            return undefined;
    }
}
