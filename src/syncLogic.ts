import { createHash } from 'crypto';

/**
 * Change tracking without the vscode API (unit-testable).
 *
 * For every file the extension remembers a "baseline": what was on the controller
 * when the file was last downloaded, uploaded or checked. From that it can tell
 *   - local changes:      hash of the local file   ≠ baseline hash,
 *   - controller changes: date in the FTP listing  ≠ baseline date.
 * The YRC1000 reports size 0 for every file, so the listing date is the only
 * cheap signal for changes on the controller.
 */

export interface Baseline {
    /** SHA-1 of the file content on the controller at the last sync. */
    hash: string;
    /** Listing date of the file on the controller at the last sync, e.g. "NOV 03 18:45". */
    stamp?: string;
}

export type ChangeStatus =
    /** Local file and controller unchanged since the last sync. */
    | 'clean'
    /** Local file changed (not uploaded yet). */
    | 'local'
    /** File changed on the controller since the last sync. */
    | 'remote'
    /** Changed on both sides. */
    | 'both'
    /** Local file that does not exist on the controller. */
    | 'localOnly'
    /** No baseline: the file was downloaded before change tracking existed. */
    | 'unknown';

export function hashContent(content: Buffer): string {
    return createHash('sha1').update(content).digest('hex');
}

/** Key of a controller file, independent of case and slashes: "JOB/MAIN.JBI". */
export function fileKey(dir: string, name: string): string {
    const d = dir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    return (d ? `${d}/${name}` : name).toUpperCase();
}

/**
 * @param localHash  hash of the local file, undefined if there is no local file
 * @param remoteStamp listing date on the controller; null = file is not on the controller; undefined = not known (not listed yet)
 */
export function classify(localHash: string | undefined, remoteStamp: string | null | undefined, baseline: Baseline | undefined): ChangeStatus {
    if (localHash !== undefined && remoteStamp === null) {
        return 'localOnly';
    }
    if (!baseline) {
        return 'unknown';
    }
    const localChanged = localHash !== undefined && localHash !== baseline.hash;
    const remoteChanged = typeof remoteStamp === 'string' && !!baseline.stamp && !sameStamp(baseline.stamp, remoteStamp);
    return localChanged && remoteChanged ? 'both' : localChanged ? 'local' : remoteChanged ? 'remote' : 'clean';
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

interface Stamp {
    year: number;
    month: number;
    day: number;
    /** "18:45", only in the short form used for recent files. */
    time?: string;
}

/**
 * Parses "NOV 03 18:45" (recent files, year omitted) and "JUL 01 2025" (older files).
 * For the short form the year is the current one, or the previous one if the date would lie in the future.
 */
export function parseStamp(raw: string, now = new Date()): Stamp | undefined {
    const m = /^(\w{3})\s+(\d{1,2})\s+(\d{1,2}:\d{2}|\d{4})$/.exec(raw.trim());
    const month = m ? MONTHS.indexOf(m[1].toUpperCase()) : -1;
    if (!m || month < 0) {
        return undefined;
    }
    const day = Number(m[2]);
    if (!m[3].includes(':')) {
        return { year: Number(m[3]), month, day };
    }
    let year = now.getFullYear();
    if (new Date(year, month, day) > new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)) {
        year--;
    }
    return { year, month, day, time: m[3].padStart(5, '0') };
}

/**
 * True if two listing dates describe the same modification. FTP servers switch from
 * "NOV 03 18:45" to "NOV 03 2025" once a file is about half a year old, so the same
 * file can be listed both ways; then only the day is compared.
 */
export function sameStamp(a: string, b: string, now = new Date()): boolean {
    if (a.trim() === b.trim()) {
        return true;
    }
    const pa = parseStamp(a, now);
    const pb = parseStamp(b, now);
    if (!pa || !pb) {
        return false;
    }
    if (pa.time && pb.time) {
        return pa.time === pb.time && pa.month === pb.month && pa.day === pb.day;
    }
    return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day;
}
