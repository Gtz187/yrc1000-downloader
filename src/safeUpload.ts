import { FtpClient } from './ftp';

/**
 * Safe upload for the YRC1000.
 *
 * When the controller rejects a file (e.g. a job with a syntax error), it answers
 * "451 Error closing file.--[5110]--" and DELETES the file. To never lose the job
 * on the controller, every upload works like this:
 *
 *   1. back up the current file from the controller (if it exists),
 *   2. upload the new file,
 *   3. if the controller rejects it, write the backup back.
 */

export interface UploadItem {
    local: string;
    dir: string;
    name: string;
}

/** Persists backups, e.g. to disk. Returns where the backup was stored. */
export type SaveBackup = (dir: string, name: string, content: Buffer) => Promise<string>;

export type RejectOutcome =
    /** The original was written back to the controller. */
    | 'restored'
    /** The file did not exist before; nothing to restore. */
    | 'newFile'
    /** Restoring the original failed. The backup file must be uploaded manually. */
    | 'restoreFailed';

export class UploadRejectedError extends Error {
    constructor(
        readonly item: UploadItem,
        readonly cause: unknown,
        readonly outcome: RejectOutcome,
        readonly backupFile: string | undefined,
        readonly restoreError?: unknown,
    ) {
        super(`${item.dir}/${item.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
        this.name = 'UploadRejectedError';
    }

    /** Controller error number, e.g. "5110" from "451 Error closing file.--[5110]--". */
    get controllerCode(): string | undefined {
        return /\[(\d+)\]/.exec(this.cause instanceof Error ? this.cause.message : String(this.cause))?.[1];
    }

    /** Controller text without reply code and error number, e.g. "Error closing file." */
    get controllerMessage(): string {
        const msg = this.cause instanceof Error ? this.cause.message : String(this.cause);
        return msg
            .replace(/^STOR failed:\s*/, '')
            .replace(/^\d{3}[\s-]*/, '')
            .replace(/-*\[\d+\]-*/, '')
            .trim();
    }
}

/** Thrown when the original could not be backed up. Nothing was uploaded in that case. */
export class BackupFailedError extends Error {
    constructor(readonly item: UploadItem, readonly cause: unknown) {
        super(`${item.dir}/${item.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
        this.name = 'BackupFailedError';
    }
}

export interface SafeUploadResult {
    /** true if an existing file was replaced (and backed up). */
    replaced: boolean;
    backupFile?: string;
}

/**
 * Uploads several files safely, one after another. Stops at the first rejected file.
 * @param onProgress called before each file.
 */
export async function safeUploadAll(
    client: FtpClient,
    items: UploadItem[],
    saveBackup: SaveBackup,
    onProgress?: (item: UploadItem, index: number) => void,
    isCancelled?: () => boolean,
): Promise<SafeUploadResult[]> {
    const listings = new Map<string, Set<string>>();
    const results: SafeUploadResult[] = [];
    for (const [i, item] of items.entries()) {
        if (isCancelled?.()) {
            break;
        }
        onProgress?.(item, i);

        // 1. Back up the current version, if there is one.
        let names = listings.get(item.dir);
        if (!names) {
            names = new Set((await client.list(item.dir)).filter((e) => !e.isDir).map((e) => e.name.toUpperCase()));
            listings.set(item.dir, names);
        }
        let original: Buffer | undefined;
        let backupFile: string | undefined;
        if (names.has(item.name.toUpperCase())) {
            try {
                original = await client.read(item.dir, item.name);
                backupFile = await saveBackup(item.dir, item.name, original);
            } catch (err) {
                throw new BackupFailedError(item, err);
            }
        }

        // 2. Upload.
        try {
            await client.upload(item.local, item.dir, item.name);
        } catch (err) {
            // 3. Rejected: the controller has deleted the file. Put the original back.
            if (!original) {
                throw new UploadRejectedError(item, err, 'newFile', undefined);
            }
            try {
                await client.write(item.dir, item.name, original);
            } catch (restoreErr) {
                throw new UploadRejectedError(item, err, 'restoreFailed', backupFile, restoreErr);
            }
            throw new UploadRejectedError(item, err, 'restored', backupFile);
        }
        names.add(item.name.toUpperCase());
        results.push({ replaced: !!original, backupFile });
    }
    return results;
}
