import * as path from 'path';
import * as vscode from 'vscode';
import { FtpClient, FtpError } from './ftp';

const t = vscode.l10n.t;

export interface Controller {
    name: string;
    host: string;
    port: number;
    username: string;
    /** Optional plain-text password from settings.json. If set, it takes precedence over the secret storage. */
    password?: string;
    /** Absolute local folder that mirrors the controller (JOB/, DAT/, …). */
    localFolder: string;
    downloadFolders: string[];
}

interface RawController {
    name?: string;
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    localFolder?: string;
    downloadFolders?: string[];
}

export type ErrorAction = 'addController' | 'settings';

/** An error with a message meant for the user (no stack trace, optional follow-up action). */
export class UserError extends Error {
    constructor(message: string, readonly action?: ErrorAction) {
        super(message);
    }
}

/** Thrown when the user cancels a dialog. Never shown. */
export class Cancelled extends Error {
    constructor() {
        super('cancelled');
    }
}

const ACTIVE_KEY = 'yrc1000.activeController';
const SESSION_IDLE_MS = 20_000;

interface Session {
    key: string;
    client: FtpClient;
    idleTimer?: NodeJS.Timeout;
}

/**
 * Knows the configured controllers, the active one, the stored passwords,
 * and owns the (re-used) FTP session. All FTP work runs strictly one after another.
 */
export class ControllerService implements vscode.Disposable {
    private readonly changedEmitter = new vscode.EventEmitter<void>();
    private readonly busyEmitter = new vscode.EventEmitter<boolean>();
    /** Fires when the controller list or the active controller changes. */
    readonly onDidChange = this.changedEmitter.event;
    /** Fires with true while FTP work is running. */
    readonly onDidChangeBusy = this.busyEmitter.event;

    private session: Session | undefined;
    private queue: Promise<unknown> = Promise.resolve();
    private pending = 0;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly ctx: vscode.ExtensionContext,
        private readonly log: vscode.LogOutputChannel,
    ) {
        this.disposables.push(
            this.changedEmitter,
            this.busyEmitter,
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('yrc1000')) {
                    this.dropSession();
                    this.changedEmitter.fire();
                }
            }),
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.changedEmitter.fire()),
        );
    }

    dispose(): void {
        this.dropSession();
        this.disposables.forEach((d) => d.dispose());
    }

    // ------------------------------------------------------------ controllers

    get workspaceRoot(): string | undefined {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    }

    list(): Controller[] {
        const root = this.workspaceRoot;
        if (!root) {
            return [];
        }
        const config = vscode.workspace.getConfiguration('yrc1000');
        const defaultFolders = config.get<string[]>('downloadFolders', ['JOB']);
        return config
            .get<RawController[]>('controllers', [])
            .filter((r) => typeof r?.host === 'string' && r.host.trim())
            .map((r) => ({
                name: (r.name ?? '').trim() || r.host!.trim(),
                host: r.host!.trim(),
                port: r.port ?? 21,
                username: (r.username ?? '').trim(),
                password: typeof r.password === 'string' && r.password !== '' ? r.password : undefined,
                localFolder: r.localFolder?.trim() ? path.resolve(root, r.localFolder.trim()) : root,
                downloadFolders: (r.downloadFolders ?? defaultFolders).map((d) => d.replace(/^\/+|\/+$/g, '')).filter(Boolean),
            }));
    }

    get active(): Controller | undefined {
        const all = this.list();
        const name = this.ctx.workspaceState.get<string>(ACTIVE_KEY);
        return all.find((c) => c.name === name) ?? all[0];
    }

    requireActive(): Controller {
        if (!this.workspaceRoot) {
            throw new UserError(t('Open a folder first. Robot files are stored in the workspace.'));
        }
        const c = this.active;
        if (!c) {
            throw new UserError(t('No robot controller configured yet.'), 'addController');
        }
        if (!c.username) {
            throw new UserError(t('No FTP user configured for "{0}".', c.name), 'settings');
        }
        return c;
    }

    async setActive(name: string): Promise<void> {
        await this.ctx.workspaceState.update(ACTIVE_KEY, name);
        this.dropSession();
        this.changedEmitter.fire();
    }

    async add(raw: RawController): Promise<void> {
        const config = vscode.workspace.getConfiguration('yrc1000');
        const current = config.inspect<RawController[]>('controllers')?.workspaceValue ?? [];
        await config.update('controllers', [...current, raw], vscode.ConfigurationTarget.Workspace);
        await this.setActive(raw.name ?? raw.host ?? '');
    }

    async remove(name: string): Promise<boolean> {
        const config = vscode.workspace.getConfiguration('yrc1000');
        const current = config.inspect<RawController[]>('controllers')?.workspaceValue ?? [];
        const next = current.filter((r) => ((r.name ?? '').trim() || r.host) !== name);
        if (next.length === current.length) {
            return false;
        }
        await config.update('controllers', next, vscode.ConfigurationTarget.Workspace);
        return true;
    }

    // -------------------------------------------------------------- passwords

    private secretKey(c: Controller): string {
        return `yrc1000.password:${c.username}@${c.host}:${c.port}`;
    }

    async getPassword(c: Controller, forcePrompt = false): Promise<string> {
        if (c.password !== undefined && !forcePrompt) {
            return c.password;
        }
        const key = this.secretKey(c);
        if (!forcePrompt) {
            const stored = await this.ctx.secrets.get(key);
            if (stored !== undefined) {
                return stored;
            }
        }
        const pw = await vscode.window.showInputBox({
            title: t('FTP password for {0}@{1}', c.username, c.host),
            prompt: t('Stored securely in the VS Code secret storage.'),
            password: true,
            ignoreFocusOut: true,
        });
        if (pw === undefined) {
            throw new Cancelled();
        }
        await this.ctx.secrets.store(key, pw);
        return pw;
    }

    /** True if connecting will not prompt for a password. */
    async hasPassword(c: Controller): Promise<boolean> {
        return c.password !== undefined || (await this.ctx.secrets.get(this.secretKey(c))) !== undefined;
    }

    async storePassword(c: Controller, password: string): Promise<void> {
        await this.ctx.secrets.store(this.secretKey(c), password);
    }

    async clearPassword(c: Controller): Promise<void> {
        await this.ctx.secrets.delete(this.secretKey(c));
        this.dropSession();
    }

    // ---------------------------------------------------------------- session

    /**
     * Runs FTP work on the active controller. Re-uses an open session for a short time,
     * so browsing the tree stays fast, and retries once if a re-used session went stale.
     */
    async run<T>(work: (client: FtpClient, c: Controller) => Promise<T>, controller?: Controller): Promise<T> {
        const c = controller ?? this.requireActive();
        const password = await this.getPassword(c);
        return this.exclusive(async () => {
            const key = `${c.username}@${c.host}:${c.port}`;
            for (let attempt = 0; ; attempt++) {
                const reused = !!this.session && this.session.key === key && this.session.client.isAlive;
                const client = reused ? this.session!.client : await this.connect(c, password, key);
                clearTimeout(this.session?.idleTimer);
                try {
                    return await work(client, c);
                } catch (err) {
                    const lost = err instanceof FtpError && err.connectionLost;
                    if (lost) {
                        this.dropSession();
                        if (reused && attempt === 0) {
                            this.log.info('Session went stale, reconnecting');
                            continue;
                        }
                    }
                    throw err;
                } finally {
                    if (this.session) {
                        this.session.idleTimer = setTimeout(() => this.dropSession(), SESSION_IDLE_MS);
                    }
                }
            }
        });
    }

    private async connect(c: Controller, password: string, key: string): Promise<FtpClient> {
        this.dropSession();
        this.log.info(`Connecting to ${c.username}@${c.host}:${c.port}`);
        const timeoutMs = vscode.workspace.getConfiguration('yrc1000').get<number>('timeout', 15000);
        try {
            const client = await FtpClient.connect({
                host: c.host,
                port: c.port,
                user: c.username,
                password,
                timeoutMs,
                log: (line) => this.log.debug(line),
            });
            this.session = { key, client };
            return client;
        } catch (err) {
            if (err instanceof FtpError && err.code === 530 && c.password !== undefined) {
                throw new UserError(t('Login to {0} failed. Please check the password of "{1}" in settings.json.', c.host, c.name), 'settings');
            }
            if (err instanceof FtpError && err.code === 530) {
                await this.ctx.secrets.delete(this.secretKey(c));
                throw new UserError(t('Login to {0} failed. Please enter the password again.', c.host));
            }
            throw err;
        }
    }

    private dropSession(): void {
        if (this.session) {
            clearTimeout(this.session.idleTimer);
            this.session.client.close();
            this.session = undefined;
        }
    }

    private exclusive<T>(fn: () => Promise<T>): Promise<T> {
        if (this.pending++ === 0) {
            this.busyEmitter.fire(true);
        }
        const run = this.queue.then(fn, fn).finally(() => {
            if (--this.pending === 0) {
                this.busyEmitter.fire(false);
            }
        });
        this.queue = run.catch(() => undefined);
        return run;
    }
}
