import * as fs from 'fs';
import * as net from 'net';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

/**
 * Minimal FTP client tailored to the YASKAWA YRC1000 FTP server.
 *
 * Why not an existing library? The YRC1000 sends a non-standard directory
 * listing ("-" instead of a link count, no owner/group) and supports neither
 * EPSV nor MLSD. Common Node FTP libraries reject that listing. This client
 * only uses PASV, binary transfers and a tolerant listing parser.
 */

export interface FtpOptions {
    host: string;
    port: number;
    user: string;
    password: string;
    timeoutMs: number;
    log?: (line: string) => void;
}

export interface FtpReply {
    code: number;
    text: string;
}

export interface RemoteEntry {
    name: string;
    isDir: boolean;
    /** Modification date as sent by the server, e.g. "NOV 03 18:45" or "JUL 01 2025". */
    modified?: string;
}

export class FtpError extends Error {
    /**
     * @param code FTP reply code, if the error came from a server reply.
     * @param connectionLost true if the control connection is gone (safe to retry on a new connection).
     */
    constructor(message: string, readonly code?: number, readonly connectionLost = false) {
        super(message);
        this.name = 'FtpError';
    }
}

interface Waiter {
    resolve: (reply: FtpReply) => void;
    reject: (err: Error) => void;
}

export class FtpClient {
    private socket: net.Socket | undefined;
    private buffer = '';
    private multilineCode: string | undefined;
    private multilineLines: string[] = [];
    private replies: FtpReply[] = [];
    private waiter: Waiter | undefined;
    private closedError: Error | undefined;
    private currentDir = '/';

    private constructor(private readonly opts: FtpOptions) {}

    static async connect(opts: FtpOptions): Promise<FtpClient> {
        const client = new FtpClient(opts);
        try {
            await client.open();
        } catch (err) {
            client.close();
            throw err;
        }
        return client;
    }

    // ---------------------------------------------------------------- public

    /** True while the control connection is usable. */
    get isAlive(): boolean {
        return !!this.socket && !this.socket.destroyed && !this.closedError;
    }

    /** Lists a remote directory, e.g. "" (root) or "JOB". */
    async list(dir: string): Promise<RemoteEntry[]> {
        await this.cwd(dir);
        const raw = await this.withData('LIST', (data) => readAll(data));
        return parseList(raw.toString('latin1'));
    }

    /** Downloads remoteDir/name to localPath (written atomically via a temp file). */
    async download(dir: string, name: string, localPath: string): Promise<void> {
        await this.cwd(dir);
        const tmp = `${localPath}.yrcpart`;
        try {
            await this.withData(`RETR ${name}`, (data) => pipeline(data, fs.createWriteStream(tmp)));
            await fs.promises.rename(tmp, localPath);
        } catch (err) {
            await fs.promises.rm(tmp, { force: true });
            throw err;
        }
    }

    /** Reads remoteDir/name into memory (used for previews and comparisons). */
    async read(dir: string, name: string): Promise<Buffer> {
        await this.cwd(dir);
        return this.withData(`RETR ${name}`, (data) => readAll(data));
    }

    /** Uploads localPath to remoteDir/name. */
    async upload(localPath: string, dir: string, name: string): Promise<void> {
        await this.cwd(dir);
        await this.withData(`STOR ${name}`, (data) => pipeline(fs.createReadStream(localPath), data));
    }

    /** Uploads an in-memory buffer to remoteDir/name (used to restore backups). */
    async write(dir: string, name: string, content: Buffer): Promise<void> {
        await this.cwd(dir);
        await this.withData(`STOR ${name}`, (data) => pipeline(Readable.from([content]), data));
    }

    close(): void {
        const sock = this.socket;
        this.socket = undefined;
        if (!sock || sock.destroyed) {
            return;
        }
        try {
            sock.write('QUIT\r\n');
        } catch {
            // ignore
        }
        sock.end();
        setTimeout(() => sock.destroy(), 1000).unref();
    }

    // ------------------------------------------------------------ connection

    private async open(): Promise<void> {
        const { host, port, timeoutMs } = this.opts;
        const sock = net.createConnection({ host, port });
        this.socket = sock;
        sock.setEncoding('latin1');
        sock.on('data', (chunk: string) => this.onData(chunk));
        sock.on('error', (err) => this.fail(new FtpError(`Connection error: ${err.message}`, undefined, true)));
        sock.on('close', () => this.fail(new FtpError('Connection closed by the controller.', undefined, true)));

        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                sock.destroy();
                reject(new FtpError(`No connection to ${host}:${port} (timeout). Check IP address, cable and FTP settings of the controller.`));
            }, timeoutMs);
            sock.once('connect', () => {
                clearTimeout(timer);
                resolve();
            });
            sock.once('error', (err) => {
                clearTimeout(timer);
                reject(new FtpError(`Cannot connect to ${host}:${port}: ${err.message}`));
            });
        });

        const greeting = await this.nextReply();
        if (greeting.code !== 220) {
            throw new FtpError(`Unexpected greeting: ${greeting.text}`, greeting.code);
        }

        let reply = await this.send(`USER ${this.opts.user}`);
        if (reply.code === 331) {
            reply = await this.send(`PASS ${this.opts.password}`);
        }
        if (reply.code !== 230 && reply.code !== 202) {
            throw new FtpError(`Login failed: ${reply.text}`, reply.code);
        }

        await this.expect('TYPE I', [200]);
        this.currentDir = '/';
    }

    /** Changes to an absolute directory like "" / "JOB" using relative steps (robust on embedded servers). */
    private async cwd(dir: string): Promise<void> {
        const target = '/' + dir.split('/').filter(Boolean).join('/');
        if (target === this.currentDir) {
            return;
        }
        // Go back to root first, then descend segment by segment.
        if (this.currentDir !== '/') {
            const r = await this.send('CWD /');
            if (r.code !== 250) {
                for (let i = this.currentDir.split('/').filter(Boolean).length; i > 0; i--) {
                    await this.expect('CDUP', [200, 250]);
                }
            }
            this.currentDir = '/';
        }
        for (const seg of target.split('/').filter(Boolean)) {
            await this.expect(`CWD ${seg}`, [250]);
            this.currentDir = this.currentDir === '/' ? `/${seg}` : `${this.currentDir}/${seg}`;
        }
    }

    // ----------------------------------------------------------- data channel

    private async openPassive(): Promise<net.Socket> {
        const reply = await this.expect('PASV', [227]);
        const m = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(reply.text);
        if (!m) {
            throw new FtpError(`Cannot parse PASV reply: ${reply.text}`);
        }
        const port = Number(m[5]) * 256 + Number(m[6]);
        // Always use the control host: the controller may report an address that is not reachable (NAT).
        const host = this.opts.host;
        const data = net.createConnection({ host, port });
        data.pause();
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                data.destroy();
                reject(new FtpError(`Data connection to ${host}:${port} timed out.`));
            }, this.opts.timeoutMs);
            data.once('connect', () => {
                clearTimeout(timer);
                resolve();
            });
            data.once('error', (err) => {
                clearTimeout(timer);
                reject(new FtpError(`Data connection failed: ${err.message}`));
            });
        });
        data.setTimeout(this.opts.timeoutMs, () => data.destroy(new FtpError('Data transfer timed out.')));
        return data;
    }

    private async withData<T>(command: string, handle: (data: net.Socket) => Promise<T>): Promise<T> {
        const data = await this.openPassive();
        try {
            const pre = await this.send(command);
            if (pre.code !== 150 && pre.code !== 125) {
                throw new FtpError(`${describe(command)} failed: ${pre.text}`, pre.code);
            }
            const result = await handle(data);
            const done = await this.nextReply();
            if (done.code !== 226 && done.code !== 250) {
                throw new FtpError(`${describe(command)} failed: ${done.text}`, done.code);
            }
            return result;
        } finally {
            data.destroy();
        }
    }

    // -------------------------------------------------------- control channel

    private async send(command: string): Promise<FtpReply> {
        if (!this.socket || this.closedError) {
            throw this.closedError ?? new FtpError('Not connected.', undefined, true);
        }
        this.log(`> ${command.startsWith('PASS ') ? 'PASS ********' : command}`);
        this.socket.write(`${command}\r\n`, 'latin1');
        return this.nextReply();
    }

    private async expect(command: string, codes: number[]): Promise<FtpReply> {
        const reply = await this.send(command);
        if (!codes.includes(reply.code)) {
            throw new FtpError(`${describe(command)} failed: ${reply.text}`, reply.code);
        }
        return reply;
    }

    private nextReply(): Promise<FtpReply> {
        const queued = this.replies.shift();
        if (queued) {
            return Promise.resolve(queued);
        }
        if (this.closedError) {
            return Promise.reject(this.closedError);
        }
        return new Promise<FtpReply>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiter = undefined;
                const err = new FtpError('The controller did not answer in time.');
                this.fail(err);
                this.socket?.destroy();
                reject(err);
            }, this.opts.timeoutMs);
            this.waiter = {
                resolve: (r) => {
                    clearTimeout(timer);
                    resolve(r);
                },
                reject: (e) => {
                    clearTimeout(timer);
                    reject(e);
                },
            };
        });
    }

    private onData(chunk: string): void {
        this.buffer += chunk;
        let idx: number;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, idx).replace(/\r$/, '');
            this.buffer = this.buffer.slice(idx + 1);
            this.onLine(line);
        }
    }

    private onLine(line: string): void {
        this.log(`< ${line}`);
        if (this.multilineCode) {
            this.multilineLines.push(line);
            if (line.startsWith(`${this.multilineCode} `)) {
                const code = Number(this.multilineCode);
                const text = this.multilineLines.join('\n');
                this.multilineCode = undefined;
                this.multilineLines = [];
                this.pushReply({ code, text });
            }
            return;
        }
        const m = /^(\d{3})([ -])/.exec(line);
        if (!m) {
            return;
        }
        if (m[2] === '-') {
            this.multilineCode = m[1];
            this.multilineLines = [line];
            return;
        }
        this.pushReply({ code: Number(m[1]), text: line });
    }

    private pushReply(reply: FtpReply): void {
        const w = this.waiter;
        if (w) {
            this.waiter = undefined;
            w.resolve(reply);
        } else {
            this.replies.push(reply);
        }
    }

    private fail(err: Error): void {
        if (!this.closedError) {
            this.closedError = err;
        }
        const w = this.waiter;
        if (w) {
            this.waiter = undefined;
            w.reject(err);
        }
    }

    private log(line: string): void {
        this.opts.log?.(line);
    }
}

// ----------------------------------------------------------------- helpers

function describe(command: string): string {
    return command.split(' ')[0];
}

function readAll(stream: net.Socket): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.once('end', () => resolve(Buffer.concat(chunks)));
        stream.once('error', reject);
        stream.resume();
    });
}

// Unix style. Tolerates the YRC1000 variant:  "----------   - ----     ---            0 JUL 01  2025 TEST2.JBI"
const UNIX_LINE =
    /^([-dlbcps])[-rwxsStTl]{9}\+?\s+\S+\s+\S+\s+\S+\s+\d+\s+(\w{3}\s+\d{1,2}\s+(?:\d{1,2}:\d{2}|\d{4}))\s+(.+)$/;
// DOS/IIS style:  "01-30-25  10:15AM       <DIR>          JOB"
const DOS_LINE = /^(\d{2}-\d{2}-\d{2,4}\s+\d{1,2}:\d{2}\s*[AP]M)\s+(<DIR>|\d+)\s+(.+)$/i;

export function parseList(text: string): RemoteEntry[] {
    const entries: RemoteEntry[] = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trimEnd();
        if (!line || /^total\s/i.test(line)) {
            continue;
        }
        let m = UNIX_LINE.exec(line);
        if (m) {
            const name = m[1] === 'l' ? m[3].split(' -> ')[0] : m[3];
            entries.push({ name, isDir: m[1] === 'd', modified: m[2].replace(/\s+/g, ' ') });
            continue;
        }
        m = DOS_LINE.exec(line);
        if (m) {
            entries.push({ name: m[3], isDir: m[2].toUpperCase() === '<DIR>', modified: m[1].replace(/\s+/g, ' ') });
            continue;
        }
        // Unknown format: last token is the name, leading "d" marks a directory.
        const parts = line.split(/\s+/);
        entries.push({ name: parts[parts.length - 1], isDir: line.startsWith('d') });
    }
    return entries.filter((e) => e.name !== '.' && e.name !== '..');
}
