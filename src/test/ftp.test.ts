import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { FtpClient, FtpError, parseList } from '../ftp';
import { safeUploadAll, UploadRejectedError } from '../safeUpload';

// ------------------------------------------------------------- parseList

describe('parseList', () => {
    it('parses the non-standard YRC1000 listing', () => {
        const text = [
            'd---------   - ----     ---            0 JAN 30  2025 JOB',
            '----------   - ----     ---            0 NOV 03 18:45 TEST1.JBI',
            '----------   - ----     ---            0 JUL 01  2025 TEST2.JBI',
            '',
        ].join('\r\n');
        assert.deepEqual(parseList(text), [
            { name: 'JOB', isDir: true, modified: 'JAN 30 2025' },
            { name: 'TEST1.JBI', isDir: false, modified: 'NOV 03 18:45' },
            { name: 'TEST2.JBI', isDir: false, modified: 'JUL 01 2025' },
        ]);
    });

    it('parses standard Unix listings, names with spaces and symlinks', () => {
        const text = [
            'total 12',
            'drwxr-xr-x  2 robot users 4096 Jan 30  2025 JOB',
            '-rw-r--r--  1 robot users  669 Nov  3 18:45 MY FILE.JBI',
            'lrwxrwxrwx  1 robot users    3 Nov  3 18:45 LINK -> JOB',
            'drwxr-xr-x  2 robot users 4096 Jan 30  2025 .',
        ].join('\n');
        assert.deepEqual(
            parseList(text).map((e) => [e.name, e.isDir]),
            [
                ['JOB', true],
                ['MY FILE.JBI', false],
                ['LINK', false],
            ],
        );
    });

    it('parses DOS listings', () => {
        const text = '01-30-25  10:15AM       <DIR>          JOB\r\n11-03-25  06:45PM                  669 MAIN.JBI';
        assert.deepEqual(
            parseList(text).map((e) => [e.name, e.isDir]),
            [
                ['JOB', true],
                ['MAIN.JBI', false],
            ],
        );
    });
});

// ------------------------------------------------- client vs. mock controller

/**
 * Tiny FTP server that behaves like the YRC1000: no EPSV/MLSD, PASV only,
 * relative CWD, YRC-style listing. Serves files from a temp directory.
 */
function startMockController(root: string, password: string): Promise<net.Server> {
    const server = net.createServer((ctrl) => {
        let cwd = root;
        let loggedIn = false;
        let pasv: net.Server | undefined;
        let dataSocket: Promise<net.Socket> | undefined;
        const reply = (line: string): void => {
            ctrl.write(`${line}\r\n`);
        };
        reply('220 YRC FTP server ( 1.00) ready.');

        let buffer = '';
        ctrl.on('data', async (chunk) => {
            buffer += chunk.toString('latin1');
            let idx: number;
            while ((idx = buffer.indexOf('\r\n')) >= 0) {
                const line = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);
                const [cmd, ...rest] = line.split(' ');
                const arg = rest.join(' ');
                await handle(cmd.toUpperCase(), arg);
            }
        });

        async function handle(cmd: string, arg: string): Promise<void> {
            if (!loggedIn && !['USER', 'PASS', 'QUIT'].includes(cmd)) {
                return reply('530 Please login with USER and PASS.');
            }
            switch (cmd) {
                case 'USER':
                    return reply(`331 Password required for ${arg}.`);
                case 'PASS':
                    if (arg !== password) {
                        return reply('530 Login incorrect.');
                    }
                    loggedIn = true;
                    return reply('230 User logged in.');
                case 'TYPE':
                    return reply(`200 Type set to ${arg}.`);
                case 'CWD': {
                    const target = arg === '/' ? root : path.join(cwd, arg);
                    if (!target.startsWith(root) || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
                        return reply(`550 ${arg}: No such directory.`);
                    }
                    cwd = target;
                    return reply('250 CWD command successful.');
                }
                case 'CDUP':
                    cwd = path.dirname(cwd).startsWith(root) ? path.dirname(cwd) : root;
                    return reply('250 CDUP command successful.');
                case 'PASV': {
                    pasv?.close();
                    pasv = net.createServer();
                    dataSocket = new Promise((resolve) => pasv!.once('connection', resolve));
                    await new Promise<void>((r) => pasv!.listen(0, '127.0.0.1', r));
                    const port = (pasv.address() as net.AddressInfo).port;
                    return reply(`227 Entering Passive Mode (127,0,0,1,${port >> 8},${port & 255})`);
                }
                case 'LIST': {
                    const sock = await dataSocket!;
                    reply('150 Opening ASCII mode data connection.');
                    const lines = fs.readdirSync(cwd, { withFileTypes: true }).map((e) => {
                        const type = e.isDirectory() ? 'd' : '-';
                        return `${type}---------   - ----     ---            0 NOV 03 18:45 ${e.name}`;
                    });
                    sock.end(lines.join('\r\n') + '\r\n', () => reply('226 Transfer complete.'));
                    return;
                }
                case 'RETR': {
                    const file = path.join(cwd, arg);
                    if (!fs.existsSync(file)) {
                        return reply(`550 ${arg}: No such file.`);
                    }
                    const sock = await dataSocket!;
                    reply('150 Opening BINARY mode data connection.');
                    sock.end(fs.readFileSync(file), () => reply('226 Transfer complete.'));
                    return;
                }
                case 'STOR': {
                    const sock = await dataSocket!;
                    reply('150 Opening BINARY mode data connection.');
                    const chunks: Buffer[] = [];
                    sock.on('data', (c) => chunks.push(c));
                    sock.on('end', () => {
                        const content = Buffer.concat(chunks);
                        const target = path.join(cwd, arg);
                        // Like the real YRC1000: an invalid job is rejected AND the file is deleted.
                        if (content.includes('SYNTAX_ERROR')) {
                            fs.rmSync(target, { force: true });
                            reply('451 Error closing file.--[5110]--');
                            return;
                        }
                        fs.writeFileSync(target, content);
                        reply('226 Transfer complete.');
                    });
                    return;
                }
                case 'QUIT':
                    reply('221 Goodbye.');
                    ctrl.end();
                    return;
                default:
                    return reply(`500 '${cmd}': command not understood.`);
            }
        }
        ctrl.on('close', () => pasv?.close());
        ctrl.on('error', () => undefined);
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

describe('FtpClient against a mock YRC1000', () => {
    let root: string;
    let local: string;
    let server: net.Server;
    let port: number;
    const job = Buffer.from('/JOB\r\n//NAME MAIN\r\nNOP\r\nMOVJ C00000 VJ=25.00\r\nEND\r\n', 'latin1');

    before(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'yrc-remote-'));
        local = fs.mkdtempSync(path.join(os.tmpdir(), 'yrc-local-'));
        fs.mkdirSync(path.join(root, 'JOB'));
        fs.mkdirSync(path.join(root, 'DAT'));
        fs.writeFileSync(path.join(root, 'JOB', 'MAIN.JBI'), job);
        server = await startMockController(root, 'secret');
        port = (server.address() as net.AddressInfo).port;
    });

    after(() => {
        server.close();
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(local, { recursive: true, force: true });
    });

    const connect = (password = 'secret') => FtpClient.connect({ host: '127.0.0.1', port, user: 'ftpuser', password, timeoutMs: 3000 });

    it('lists, switches folders, downloads and uploads byte-exact', async () => {
        const client = await connect();
        try {
            const rootList = await client.list('');
            assert.deepEqual(rootList.map((e) => e.name).sort(), ['DAT', 'JOB']);
            assert.deepEqual((await client.list('JOB')).map((e) => e.name), ['MAIN.JBI']);
            assert.deepEqual(await client.list('DAT'), []);

            const target = path.join(local, 'MAIN.JBI');
            await client.download('JOB', 'MAIN.JBI', target);
            assert.deepEqual(fs.readFileSync(target), job);
            assert.equal(fs.existsSync(`${target}.yrcpart`), false);

            assert.deepEqual(await client.read('JOB', 'MAIN.JBI'), job);

            const changed = Buffer.concat([job, Buffer.from("' changed\r\n", 'latin1')]);
            fs.writeFileSync(target, changed);
            await client.upload(target, 'JOB', 'NEW.JBI');
            assert.deepEqual(fs.readFileSync(path.join(root, 'JOB', 'NEW.JBI')), changed);
        } finally {
            client.close();
        }
    });

    it('reports a wrong password with code 530', async () => {
        await assert.rejects(connect('wrong'), (err: unknown) => err instanceof FtpError && err.code === 530);
    });

    it('reports a missing file and leaves no partial download behind', async () => {
        const client = await connect();
        try {
            const target = path.join(local, 'MISSING.JBI');
            await assert.rejects(client.download('JOB', 'MISSING.JBI', target), (err: unknown) => err instanceof FtpError && err.code === 550);
            assert.equal(fs.existsSync(target), false);
            assert.equal(fs.existsSync(`${target}.yrcpart`), false);
            // The session is still usable afterwards.
            assert.equal((await client.list('JOB')).length >= 1, true);
        } finally {
            client.close();
        }
    });

    describe('safe upload', () => {
        const remote = (name: string) => path.join(root, 'JOB', name);
        const writeLocal = (name: string, content: string) => {
            const file = path.join(local, name);
            fs.writeFileSync(file, content, 'latin1');
            return file;
        };
        const backups: Record<string, Buffer> = {};
        const saveBackup = async (dir: string, name: string, content: Buffer) => {
            backups[`${dir}/${name}`] = content;
            return path.join(local, 'backup', name);
        };

        it('backs up the original and replaces it', async () => {
            fs.writeFileSync(remote('A.JBI'), 'ORIGINAL A');
            const client = await connect();
            try {
                const results = await safeUploadAll(client, [{ local: writeLocal('A.JBI', 'NEW A'), dir: 'JOB', name: 'A.JBI' }], saveBackup);
                assert.deepEqual(results, [{ replaced: true, backupFile: path.join(local, 'backup', 'A.JBI') }]);
                assert.equal(fs.readFileSync(remote('A.JBI'), 'latin1'), 'NEW A');
                assert.equal(backups['JOB/A.JBI'].toString(), 'ORIGINAL A');
            } finally {
                client.close();
            }
        });

        it('restores the original when the controller rejects the file (451 [5110])', async () => {
            fs.writeFileSync(remote('MV_KLEBEN.JBI'), 'GOOD JOB');
            const client = await connect();
            try {
                const item = { local: writeLocal('MV_KLEBEN.JBI', 'NOP\r\nSYNTAX_ERROR\r\nEND'), dir: 'JOB', name: 'MV_KLEBEN.JBI' };
                await assert.rejects(safeUploadAll(client, [item], saveBackup), (err: unknown) => {
                    assert.ok(err instanceof UploadRejectedError);
                    assert.equal(err.outcome, 'restored');
                    assert.equal(err.controllerCode, '5110');
                    assert.equal(err.controllerMessage, 'Error closing file.');
                    return true;
                });
                assert.equal(fs.readFileSync(remote('MV_KLEBEN.JBI'), 'latin1'), 'GOOD JOB');
            } finally {
                client.close();
            }
        });

        it('reports a rejected new file without restoring anything', async () => {
            const client = await connect();
            try {
                const item = { local: writeLocal('BRAND_NEW.JBI', 'SYNTAX_ERROR'), dir: 'JOB', name: 'BRAND_NEW.JBI' };
                await assert.rejects(
                    safeUploadAll(client, [item], saveBackup),
                    (err: unknown) => err instanceof UploadRejectedError && err.outcome === 'newFile',
                );
                assert.equal(fs.existsSync(remote('BRAND_NEW.JBI')), false);
            } finally {
                client.close();
            }
        });

        it('stops a batch at the first rejected file', async () => {
            fs.writeFileSync(remote('B1.JBI'), 'OLD B1');
            fs.writeFileSync(remote('B2.JBI'), 'OLD B2');
            fs.writeFileSync(remote('B3.JBI'), 'OLD B3');
            const client = await connect();
            try {
                const items = [
                    { local: writeLocal('B1.JBI', 'NEW B1'), dir: 'JOB', name: 'B1.JBI' },
                    { local: writeLocal('B2.JBI', 'SYNTAX_ERROR'), dir: 'JOB', name: 'B2.JBI' },
                    { local: writeLocal('B3.JBI', 'NEW B3'), dir: 'JOB', name: 'B3.JBI' },
                ];
                await assert.rejects(
                    safeUploadAll(client, items, saveBackup),
                    (err: unknown) => err instanceof UploadRejectedError && err.item.name === 'B2.JBI' && err.outcome === 'restored',
                );
                assert.equal(fs.readFileSync(remote('B1.JBI'), 'latin1'), 'NEW B1');
                assert.equal(fs.readFileSync(remote('B2.JBI'), 'latin1'), 'OLD B2');
                assert.equal(fs.readFileSync(remote('B3.JBI'), 'latin1'), 'OLD B3');
                // The session is still usable after a rejection.
                assert.ok((await client.list('JOB')).length > 0);
            } finally {
                client.close();
            }
        });
    });

    it('fails fast when nothing listens on the port', async () => {
        const blocker = net.createServer();
        await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
        const freePort = (blocker.address() as net.AddressInfo).port;
        await new Promise<void>((r) => blocker.close(() => r()));
        await assert.rejects(
            FtpClient.connect({ host: '127.0.0.1', port: freePort, user: 'u', password: 'p', timeoutMs: 2000 }),
            FtpError,
        );
    });
});
