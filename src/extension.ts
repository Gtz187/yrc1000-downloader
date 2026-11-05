import * as vscode from 'vscode';
import { ChangeTracker } from './changes';
import { Commands } from './commands';
import { Cancelled, ControllerService, UserError } from './controllers';
import { REMOTE_SCHEME, RemoteDocumentProvider, remoteTargetOf, RemoteTree } from './tree';

const t = vscode.l10n.t;

export function activate(context: vscode.ExtensionContext): void {
    const log = vscode.window.createOutputChannel('YRC1000', { log: true });
    const service = new ControllerService(context, log);
    const changes = new ChangeTracker(context, service, log);
    const tree = new RemoteTree(service, (c, dir, entries) => changes.noteListing(c, dir, entries));
    const commands = new Commands(service, tree, log, vscode.Uri.joinPath(context.globalStorageUri, 'backups').fsPath, changes);
    const status = vscode.window.createStatusBarItem('yrc1000.status', vscode.StatusBarAlignment.Left, 50);
    status.name = 'YRC1000';
    status.command = 'yrc1000.switchController';

    const reportError = (err: unknown): void => {
        if (err instanceof Cancelled) {
            return;
        }
        const message = err instanceof Error ? err.message : String(err);
        log.error(message);
        const actions: Record<string, () => unknown> = {};
        if (err instanceof UserError && err.action === 'addController') {
            actions[t('Add Robot Controller…')] = () => vscode.commands.executeCommand('yrc1000.addController');
        } else if (err instanceof UserError && err.action === 'settings') {
            actions[t('Open Settings')] = () => vscode.commands.executeCommand('yrc1000.openSettings');
        } else if (!(err instanceof UserError)) {
            actions[t('Show Log')] = () => log.show();
        }
        void vscode.window.showErrorMessage(`YRC1000: ${message}`, ...Object.keys(actions)).then((a) => a && actions[a]());
    };

    const register = (id: string, fn: (...args: any[]) => unknown) =>
        context.subscriptions.push(
            vscode.commands.registerCommand(id, async (...args: any[]) => {
                try {
                    await fn(...args);
                } catch (err) {
                    reportError(err);
                }
            }),
        );

    register('yrc1000.addController', () => commands.addController());
    register('yrc1000.switchController', () => commands.switchController());
    register('yrc1000.removeController', () => commands.removeController());
    register('yrc1000.testConnection', () => commands.testConnection());
    register('yrc1000.setPassword', () => commands.setPassword());
    register('yrc1000.clearPassword', () => commands.clearPassword());
    register('yrc1000.downloadConfigured', () => commands.downloadConfigured());
    register('yrc1000.downloadSelected', () => commands.downloadSelected());
    register('yrc1000.downloadItem', (node, nodes) => commands.downloadItem(node, nodes));
    register('yrc1000.openRemoteFile', (node) => commands.openRemoteFile(node));
    register('yrc1000.upload', (uri, uris) => commands.upload(uri, uris));
    register('yrc1000.compare', (arg) => commands.compare(arg));
    register('yrc1000.openBackups', () => commands.openBackups());
    register('yrc1000.showChanges', () => commands.showChanges());
    register('yrc1000.checkChanges', () => commands.checkChanges());
    register('yrc1000.refresh', () => tree.refresh());
    register('yrc1000.showLog', () => log.show());
    register('yrc1000.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`));
    register('yrc1000.editControllers', () => vscode.commands.executeCommand('workbench.action.openWorkspaceSettingsFile'));

    const updateState = (busy = false) => {
        const c = service.active;
        void vscode.commands.executeCommand('setContext', 'yrc1000.hasController', !!c);
        if (!c) {
            status.hide();
            return;
        }
        status.text = `${busy ? '$(sync~spin)' : '$(robot)'} ${c.name}`;
        status.tooltip = new vscode.MarkdownString(
            `**YRC1000 · ${c.name}**\n\n${c.username}@${c.host}:${c.port}\n\n${t('Click to switch controller')}`,
        );
        status.show();
    };
    updateState();

    context.subscriptions.push(
        log,
        service,
        changes,
        tree,
        status,
        vscode.window.registerFileDecorationProvider(changes),
        changes.onDidChangeSummary((files) => {
            tree.view.badge = files.length ? { value: files.length, tooltip: t('{0} changed file(s)', files.length) } : undefined;
        }),
        service.onDidChange(() => updateState()),
        service.onDidChangeBusy((busy) => updateState(busy)),
        vscode.workspace.registerTextDocumentContentProvider(REMOTE_SCHEME, new RemoteDocumentProvider(service)),
        vscode.workspace.onDidSaveTextDocument((doc) => {
            const c = service.active;
            if (!c || !vscode.workspace.getConfiguration('yrc1000').get<boolean>('uploadOnSave', false)) {
                return;
            }
            if (remoteTargetOf(c, doc.uri.fsPath)?.dir) {
                commands.uploadOnSave(doc).catch(reportError);
            }
        }),
    );
}

export function deactivate(): void {
    // Disposables registered in activate() close the FTP session.
}
