import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Cancelled, Controller, ControllerService, UserError } from './controllers';
import { RemoteEntry } from './ftp';

const t = vscode.l10n.t;

export const REMOTE_SCHEME = 'yrc1000-remote';

export class RemoteNode {
    constructor(
        readonly controller: string,
        readonly dir: string,
        readonly name: string,
        readonly isDir: boolean,
        readonly modified?: string,
    ) {}

    get remotePath(): string {
        return this.dir ? `${this.dir}/${this.name}` : this.name;
    }
}

export function sortEntries<T extends RemoteEntry>(entries: T[]): T[] {
    return [...entries].sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.isDir ? -1 : 1));
}

export function localPathFor(c: Controller, dir: string, name: string): string {
    return path.join(c.localFolder, ...dir.split('/').filter(Boolean), name);
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

/** Read-only URI that shows a file straight from the controller. */
export function remoteUri(c: Controller, dir: string, name: string, fresh = false): vscode.Uri {
    const query = new URLSearchParams({ controller: c.name });
    if (fresh) {
        query.set('t', String(Date.now()));
    }
    return vscode.Uri.from({ scheme: REMOTE_SCHEME, path: `/${dir}/${name}`, query: query.toString() });
}

/** Serves yrc1000-remote: documents (read-only previews of controller files). */
export class RemoteDocumentProvider implements vscode.TextDocumentContentProvider {
    constructor(private readonly service: ControllerService) {}

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const controllerName = new URLSearchParams(uri.query).get('controller') ?? '';
        const controller = this.service.list().find((c) => c.name === controllerName);
        if (!controller) {
            throw new UserError(t('Controller "{0}" is no longer configured.', controllerName));
        }
        const parts = uri.path.split('/').filter(Boolean);
        const name = parts.pop() ?? '';
        const buffer = await this.service.run((client) => client.read(parts.join('/'), name), controller);
        return new TextDecoder('utf-8').decode(buffer);
    }
}

export class RemoteTree implements vscode.TreeDataProvider<RemoteNode>, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<RemoteNode | undefined>();
    readonly onDidChangeTreeData = this.changed.event;
    readonly view: vscode.TreeView<RemoteNode>;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly service: ControllerService,
        /** Called with every folder listing, e.g. to detect changes on the controller. */
        private readonly onListing?: (c: Controller, dir: string, entries: RemoteEntry[]) => void,
    ) {
        this.view = vscode.window.createTreeView('yrc1000.remote', { treeDataProvider: this, showCollapseAll: true, canSelectMany: true });
        this.disposables.push(this.view, this.changed, service.onDidChange(() => this.refresh()));
        this.updateDescription();
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }

    refresh(): void {
        this.updateDescription();
        this.changed.fire(undefined);
    }

    private updateDescription(): void {
        const c = this.service.active;
        this.view.description = c ? `${c.name} · ${c.host}` : undefined;
    }

    getTreeItem(node: RemoteNode): vscode.TreeItem {
        const item = new vscode.TreeItem(
            node.name,
            node.isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        );
        item.id = `${node.controller}/${node.remotePath}`;
        item.resourceUri = vscode.Uri.from({ scheme: 'yrc1000', path: `/${node.remotePath}` });
        if (node.isDir) {
            item.iconPath = vscode.ThemeIcon.Folder;
            item.contextValue = 'yrcDir';
            item.tooltip = `/${node.remotePath}`;
            return item;
        }

        item.iconPath = vscode.ThemeIcon.File;
        const c = this.service.active;
        const hasLocal = !!c && fs.existsSync(localPathFor(c, node.dir, node.name));
        item.contextValue = hasLocal ? 'yrcFile.local' : 'yrcFile';
        item.description = [formatDate(node.modified), hasLocal ? t('local') : undefined].filter(Boolean).join(' · ');
        item.tooltip = new vscode.MarkdownString(
            [
                `**/${node.remotePath}**`,
                node.modified ? t('Modified on controller: {0}', formatDate(node.modified)) : undefined,
                hasLocal ? t('A local copy exists.') : t('Not downloaded yet.'),
            ]
                .filter(Boolean)
                .join('\n\n'),
        );
        item.command = { command: 'yrc1000.openRemoteFile', title: t('Open'), arguments: [node] };
        return item;
    }

    async getChildren(node?: RemoteNode): Promise<RemoteNode[]> {
        const c = this.service.active;
        if (!c || !this.service.workspaceRoot) {
            return [];
        }
        const dir = node ? node.remotePath : '';
        try {
            const entries = await this.service.run((client) => client.list(dir));
            this.view.message = undefined;
            if (dir) {
                this.onListing?.(c, dir, entries);
            }
            return sortEntries(entries).map((e) => new RemoteNode(c.name, dir, e.name, e.isDir, e.modified));
        } catch (err) {
            if (!(err instanceof Cancelled)) {
                const msg = err instanceof Error ? err.message : String(err);
                this.view.message = `$(warning) ${msg}`;
            }
            return [];
        }
    }
}

const MONTHS: Record<string, string> = {
    JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
    JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

/** "NOV 03 18:45" → "03.11. 18:45", "JUL 01 2025" → "01.07.2025" (locale-aware order). */
export function formatDate(raw?: string): string {
    if (!raw) {
        return '';
    }
    const m = /^(\w{3}) (\d{1,2}) (\d{1,2}:\d{2}|\d{4})$/.exec(raw.trim());
    const month = m && MONTHS[m[1].toUpperCase()];
    if (!m || !month) {
        return raw;
    }
    const day = m[2].padStart(2, '0');
    const isTime = m[3].includes(':');
    const year = isTime ? new Date().getFullYear() : Number(m[3]);
    const date = new Date(year, Number(month) - 1, Number(day));
    const datePart = date.toLocaleDateString(vscode.env.language, isTime ? { day: '2-digit', month: '2-digit' } : { day: '2-digit', month: '2-digit', year: 'numeric' });
    return isTime ? `${datePart} ${m[3]}` : datePart;
}
