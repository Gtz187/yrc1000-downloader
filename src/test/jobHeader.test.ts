import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { adoptRobotValues, compareHeaders, needsAttention, parseJob, parseVarDat } from '../jobHeader';

const job = (opts: { date?: string; c0?: string; p16?: string; p18?: string; lvars?: string } = {}) =>
    [
        '/JOB',
        '//NAME ABSTREIFEN',
        '//POS',
        '///NPOS 1,0,0,3,0,0',
        '///TOOL 1',
        '///POSTYPE PULSE',
        '///PULSE',
        `C00000=${opts.c0 ?? '70513,-75109,-96231,-1894,227542,-54223'}`,
        '///POSTYPE BASE',
        '///RECTAN',
        '///RCONF 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0',
        `P00016=${opts.p16 ?? '927.418,14.788,1425.082,-1.3240,0.0301,-92.3652'}`,
        'P00017=963.193,539.847,1425.064,-1.3238,0.0307,-92.3650',
        ...(opts.p18 ? ['///TOOL 0', `P00018=${opts.p18}`] : []),
        '//INST',
        `///DATE ${opts.date ?? '2026/11/04 17:00'}`,
        ...(opts.lvars ? [`///LVARS ${opts.lvars}`] : []),
        '///ATTR SC,RW',
        '///GROUP1 RB1',
        'NOP',
        'MOVJ P0016 VJ=D153 PL=1',
        'END',
        '',
    ].join('\r\n');

describe('parseJob', () => {
    it('reads local and global positions with their context', () => {
        const h = parseJob(job({ p18: '0.000,0.000,43.000,0.0000,0.0000,0.0000' }));
        assert.equal(h.name, 'ABSTREIFEN');
        assert.equal(h.date, '2026/11/04 17:00');
        assert.deepEqual([...h.vars.keys()], ['C000', 'P016', 'P017', 'P018']);
        assert.equal(h.vars.get('C000')!.postype, 'PULSE');
        assert.equal(h.vars.get('P016')!.postype, 'BASE');
        assert.deepEqual(h.vars.get('P016')!.values, [927.418, 14.788, 1425.082, -1.324, 0.0301, -92.3652]);
        assert.notEqual(h.vars.get('P016')!.context, h.vars.get('P018')!.context); // ///TOOL 1 vs 0
        assert.equal(h.attributes.get('///ATTR'), 'SC,RW');
        assert.equal(h.attributes.has('MOVJ'), false);
    });
});

describe('compareHeaders', () => {
    it('finds nothing for identical jobs', () => {
        const c = compareHeaders(job(), job());
        assert.equal(needsAttention(c), false);
        assert.deepEqual(c.attributes, []);
    });

    it('reports a global position that was re-taught on the controller', () => {
        const robot = job({ p16: '930.000,14.788,1425.082,-1.3240,0.0301,-92.3652', date: '2026/11/05 09:12' });
        const c = compareHeaders(job(), robot);
        assert.equal(c.diffs.length, 1);
        assert.equal(c.diffs[0].name, 'P00016');
        assert.equal(c.diffs[0].global, true);
        assert.equal(c.diffs[0].source, 'job');
        assert.deepEqual(c.diffs[0].robotValues.slice(0, 1), [930]);
        assert.equal(c.robotNewer, true);
    });

    it('ignores formatting differences within the tolerance', () => {
        const c = compareHeaders(job({ p16: '927.4180,14.788,1425.082,-1.324,0.0301,-92.3652' }), job());
        assert.equal(c.diffs.length, 0);
    });

    it('reports re-taught local positions, globals first', () => {
        const robot = job({ c0: '70513,-75109,-96231,-1894,227542,-54000', p16: '930.000,14.788,1425.082,-1.3240,0.0301,-92.3652' });
        const c = compareHeaders(job(), robot);
        assert.deepEqual(
            c.diffs.map((d) => [d.name, d.global]),
            [
                ['P00016', true],
                ['C00000', false],
            ],
        );
    });

    it('checks globals the controller job does not use against VAR.DAT', () => {
        const varDat = parseVarDat(
            [
                '//VAR',
                '///B',
                '0,0,0',
                '///P',
                ...Array.from({ length: 18 }, () => '"PULSE"0,0,1,000000000000000000000000,0,0,0,0,0,0,0,0,0,0'),
                '"RECTAN"0,0,0,000000000000000000000000,0,16,0.000,0.000,50.000,0.0000,0.0000,0.0000,0.0000,0.0000',
                '///BP',
                '///EX',
                '',
            ].join('\r\n'),
        );
        assert.deepEqual(varDat.get('P018')!.values.slice(0, 3), [0, 0, 50]);
        const local = job({ p18: '0.000,0.000,43.000,0.0000,0.0000,0.0000' });
        const c = compareHeaders(local, job(), varDat);
        assert.deepEqual(
            c.diffs.map((d) => [d.name, d.source, d.replacement]),
            [['P00018', 'VAR.DAT', undefined]],
        );
        // Without VAR.DAT the value is unknown.
        assert.deepEqual(compareHeaders(local, job()).unknown, ['P00018']);
    });

    it('treats a job that is new on the controller as harmless, except for globals', () => {
        const c = compareHeaders(job(), undefined);
        assert.deepEqual(c.unknown, ['P00016', 'P00017']);
        assert.equal(c.diffs.length, 0);
        assert.equal(c.robotNewer, false);
    });

    it('lists other header lines that differ', () => {
        const c = compareHeaders(job({ lvars: '2,0,0' }), job({ lvars: '1,0,0' }));
        assert.deepEqual(c.attributes, [{ keyword: '///LVARS', robot: '1,0,0', local: '2,0,0' }]);
    });
});

describe('adoptRobotValues', () => {
    it('takes over the controller values and keeps the program and CRLF', () => {
        const local = job({ date: '2026/11/05 10:00' }).replace('MOVJ P0016', 'MOVL P0016');
        const robot = job({ p16: '930.000,14.788,1425.082,-1.3240,0.0301,-92.3652', c0: '1,2,3,4,5,6' });
        const c = compareHeaders(local, robot);
        const adopted = adoptRobotValues(local, c.diffs);
        assert.ok(adopted.includes('\r\nP00016=930.000,14.788,1425.082,-1.3240,0.0301,-92.3652\r\n'));
        assert.ok(adopted.includes('\r\nC00000=1,2,3,4,5,6\r\n'));
        assert.ok(adopted.includes('MOVL P0016'));
        assert.equal(compareHeaders(adopted, robot).diffs.length, 0);
    });

    it('does not take over values written in a different context', () => {
        const robot = job().replace('///POSTYPE BASE', '///POSTYPE USER').replace('P00016=927.418', 'P00016=100.000');
        const c = compareHeaders(job(), robot);
        assert.equal(c.diffs.find((d) => d.name === 'P00016')!.replacement, undefined);
    });
});
