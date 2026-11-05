/**
 * Job header comparison for INFORM jobs (.JBI), without the vscode API (unit-testable).
 *
 * The //POS section of a job holds its local positions (C, BC, EC) and the
 * values of the GLOBAL position variables it uses (P, BP, EX). When a job is
 * loaded, the controller writes those global values into its variable area,
 * so an upload with an outdated header silently overwrites points that were
 * taught on the teach pendant – also for every other job that uses them.
 */

export type VarKind = 'C' | 'BC' | 'EC' | 'P' | 'BP' | 'EX';

const GLOBAL_KINDS: ReadonlySet<VarKind> = new Set<VarKind>(['P', 'BP', 'EX']);

export interface PosVar {
    kind: VarKind;
    index: number;
    /** Normalized key, e.g. "P016", "C000". */
    key: string;
    /** Name as written in the file, e.g. "P00016". */
    name: string;
    /** Context the value is written in: ///POSTYPE, ///TOOL, ///USER, ///RCONF, ////FRAME. */
    postype: string;
    context: string;
    values: number[];
    /** Index of the value line in the file (0-based). */
    line: number;
}

export interface JobHeader {
    name?: string;
    /** ///DATE, e.g. "2026/11/04 17:00". */
    date?: string;
    vars: Map<string, PosVar>;
    /** Other header lines of //INST and //ARGINFO (///ATTR, ///GROUP1, ///LVARS, …) by keyword. */
    attributes: Map<string, string>;
}

export function isGlobal(kind: VarKind): boolean {
    return GLOBAL_KINDS.has(kind);
}

export function varKey(kind: VarKind, index: number): string {
    return `${kind}${String(index).padStart(3, '0')}`;
}

const VAR_LINE = /^(BC|EC|BP|EX|C|P)(\d+)=(.*)$/;

export function parseJob(text: string): JobHeader {
    const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
    const header: JobHeader = { vars: new Map(), attributes: new Map() };
    let section = '';
    let postype = '';
    const ctx: Record<string, string> = {};
    for (const [i, line] of lines.entries()) {
        if (/^\/\/[A-Z]/.test(line)) {
            const [kw, ...rest] = line.slice(2).split(' ');
            if (kw === 'NAME') {
                header.name = rest.join(' ').trim();
            } else {
                section = kw;
                if (kw === 'ARGINFO') {
                    header.attributes.set('//ARGINFO', rest.join(' ').trim());
                }
            }
            continue;
        }
        if (section === 'INST' && !line.startsWith('/')) {
            break; // end of header: instructions start (NOP)
        }
        const keyword = /^(\/{3,4})(\w+)\s?(.*)$/.exec(line);
        if (keyword) {
            const [, slashes, kw, value] = keyword;
            if (section === 'POS') {
                if (kw === 'POSTYPE') {
                    postype = value.trim();
                } else if (['TOOL', 'USER', 'RCONF', 'FRAME', 'ROBOT'].includes(kw)) {
                    ctx[`${slashes}${kw}`] = value.trim();
                }
            } else if (kw === 'DATE') {
                header.date = value.trim();
            } else {
                header.attributes.set(`${slashes}${kw}`, value.trim());
            }
            continue;
        }
        const m = section === 'POS' ? VAR_LINE.exec(line) : null;
        if (m) {
            const kind = m[1] as VarKind;
            const index = Number(m[2]);
            const key = varKey(kind, index);
            header.vars.set(key, {
                kind,
                index,
                key,
                name: `${m[1]}${m[2]}`,
                postype,
                context: Object.entries(ctx)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([k, v]) => `${k} ${v}`)
                    .join('; '),
                values: m[3].split(',').map((v) => Number(v.trim())),
                line: i,
            });
        }
    }
    return header;
}

/** Global position variables from DAT/VAR.DAT: the line number inside ///P, ///BP, ///EX is the variable index. */
export function parseVarDat(text: string): Map<string, { postype: string; values: number[] }> {
    const result = new Map<string, { postype: string; values: number[] }>();
    let kind: VarKind | undefined;
    let index = 0;
    for (const raw of text.split('\n')) {
        const line = raw.replace(/\r$/, '');
        const section = /^\/\/\/(\w+)/.exec(line);
        if (section) {
            kind = (['P', 'BP', 'EX'] as string[]).includes(section[1]) ? (section[1] as VarKind) : undefined;
            index = 0;
            continue;
        }
        if (!kind || line.startsWith('/')) {
            continue;
        }
        // "RECTAN"0,0,1,000000000000000000000000,0,16,927.418,14.788,1425.082,-1.3240,0.0301,-92.3652,0.0000,0.0000
        const m = /^"(\w+)"(.*)$/.exec(line);
        if (m) {
            const fields = m[2].split(',');
            result.set(varKey(kind, index), { postype: m[1], values: fields.slice(6).map((v) => Number(v.trim())) });
        }
        index++;
    }
    return result;
}

export interface VarDiff {
    key: string;
    name: string;
    global: boolean;
    local: PosVar;
    /** Current value on the controller. */
    robotValues: number[];
    /** Where the controller value comes from. */
    source: 'job' | 'VAR.DAT';
    /** The line of the robot job, if the value can be taken over 1:1 (same position type and context). */
    replacement?: string;
}

export interface HeaderComparison {
    diffs: VarDiff[];
    /** Global variables of the local file whose current value on the controller is unknown. */
    unknown: string[];
    /** The job on the controller is newer than the local file (///DATE). */
    robotNewer: boolean;
    localDate?: string;
    robotDate?: string;
    /** Other header lines that differ, e.g. "///LVARS: 2,0,0 → 3,0,0". */
    attributes: { keyword: string; robot?: string; local?: string }[];
}

function sameValues(a: number[], b: number[]): boolean {
    const n = Math.min(a.length, b.length);
    if (!n) {
        return a.length === b.length;
    }
    for (let i = 0; i < n; i++) {
        if (!Number.isFinite(a[i]) || !Number.isFinite(b[i]) || Math.abs(a[i] - b[i]) > 0.0005) {
            return false;
        }
    }
    // Extra values (e.g. two external axes in VAR.DAT) must be zero.
    return [...a.slice(n), ...b.slice(n)].every((v) => v === 0);
}

/** "2026/11/04 17:00" → comparable number; undefined if unparsable. */
function dateValue(date?: string): number | undefined {
    const m = date && /^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/.exec(date);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : undefined;
}

/**
 * Compares the header of a local job with the job currently on the controller.
 * @param robotJobText the job as read from the controller, undefined if it does not exist there
 * @param varDat global variables from the controller's VAR.DAT, for globals the robot job does not use
 */
export function compareHeaders(
    localText: string,
    robotJobText: string | undefined,
    varDat?: Map<string, { postype: string; values: number[] }>,
): HeaderComparison {
    const local = parseJob(localText);
    const robot = robotJobText !== undefined ? parseJob(robotJobText) : undefined;
    const diffs: VarDiff[] = [];
    const unknown: string[] = [];

    for (const v of local.vars.values()) {
        const r = robot?.vars.get(v.key);
        if (r) {
            if (!sameValues(v.values, r.values) || v.postype !== r.postype) {
                const robotLines = robotJobText!.split('\n');
                diffs.push({
                    key: v.key,
                    name: v.name,
                    global: isGlobal(v.kind),
                    local: v,
                    robotValues: r.values,
                    source: 'job',
                    replacement:
                        v.postype === r.postype && v.context === r.context ? robotLines[r.line].replace(/\r$/, '').replace(/^\w+=/, `${v.name}=`) : undefined,
                });
            }
            continue;
        }
        if (!isGlobal(v.kind)) {
            continue; // local position that is new in this version of the job
        }
        const g = varDat?.get(v.key);
        if (!g) {
            unknown.push(v.name);
            continue;
        }
        const pulse = v.postype === 'PULSE';
        if ((g.postype === 'PULSE') !== pulse || !sameValues(v.values, g.values.slice(0, v.values.length))) {
            diffs.push({ key: v.key, name: v.name, global: true, local: v, robotValues: g.values.slice(0, v.values.length), source: 'VAR.DAT' });
        }
    }

    const attributes: HeaderComparison['attributes'] = [];
    if (robot) {
        for (const kw of new Set([...local.attributes.keys(), ...robot.attributes.keys()])) {
            if (local.attributes.get(kw) !== robot.attributes.get(kw)) {
                attributes.push({ keyword: kw, robot: robot.attributes.get(kw), local: local.attributes.get(kw) });
            }
        }
    }
    const l = dateValue(local.date);
    const r = dateValue(robot?.date);
    return {
        diffs: diffs.sort((a, b) => Number(b.global) - Number(a.global) || a.key.localeCompare(b.key)),
        unknown,
        robotNewer: l !== undefined && r !== undefined && r > l,
        localDate: local.date,
        robotDate: robot?.date,
        attributes,
    };
}

/** True if the comparison is worth asking the user before uploading. */
export function needsAttention(c: HeaderComparison): boolean {
    return c.diffs.length > 0 || c.robotNewer;
}

/** Replaces the value lines of the given diffs with the controller's lines. Keeps line endings. */
export function adoptRobotValues(localText: string, diffs: VarDiff[]): string {
    const lines = localText.split('\n');
    for (const d of diffs) {
        if (d.replacement !== undefined) {
            const cr = lines[d.local.line].endsWith('\r') ? '\r' : '';
            lines[d.local.line] = d.replacement + cr;
        }
    }
    return lines.join('\n');
}

export function formatValues(values: number[]): string {
    return values.map((v) => String(v)).join(', ');
}
