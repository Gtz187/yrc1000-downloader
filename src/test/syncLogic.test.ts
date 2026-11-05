import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classify, fileKey, hashContent, parseStamp, sameStamp } from '../syncLogic';

const NOW = new Date(2026, 10, 5, 12, 0); // 5 Nov 2026

describe('sameStamp', () => {
    it('compares identical and different times', () => {
        assert.equal(sameStamp('NOV 03 18:45', 'NOV 03 18:45', NOW), true);
        assert.equal(sameStamp('NOV 03 18:45', 'NOV 03 18:46', NOW), false);
        assert.equal(sameStamp('NOV 03 18:45', 'NOV 04 18:45', NOW), false);
    });

    it('treats the short and the long form of the same day as equal', () => {
        assert.equal(sameStamp('JUN 10 08:15', 'JUN 10 2026', NOW), true);
        assert.equal(sameStamp('JUN 10 08:15', 'JUN 10 2025', NOW), false);
    });

    it('puts short-form dates in the future into the previous year', () => {
        assert.equal(parseStamp('DEC 20 10:00', NOW)?.year, 2025);
        assert.equal(parseStamp('NOV 05 10:00', NOW)?.year, 2026);
        assert.equal(sameStamp('DEC 20 10:00', 'DEC 20 2025', NOW), true);
    });

    it('does not match unparsable dates', () => {
        assert.equal(sameStamp('garbage', 'NOV 03 18:45', NOW), false);
        assert.equal(parseStamp('FOO 01 2025', NOW), undefined);
    });
});

describe('classify', () => {
    const base = { hash: hashContent(Buffer.from('A')), stamp: 'NOV 03 18:45' };
    const same = base.hash;
    const other = hashContent(Buffer.from('B'));

    it('detects local, controller and two-sided changes', () => {
        assert.equal(classify(same, 'NOV 03 18:45', base), 'clean');
        assert.equal(classify(other, 'NOV 03 18:45', base), 'local');
        assert.equal(classify(same, 'NOV 05 09:12', base), 'remote');
        assert.equal(classify(other, 'NOV 05 09:12', base), 'both');
    });

    it('ignores the controller side while its folder was not listed', () => {
        assert.equal(classify(same, undefined, base), 'clean');
        assert.equal(classify(other, undefined, base), 'local');
    });

    it('reports local-only files and files without baseline', () => {
        assert.equal(classify(same, null, base), 'localOnly');
        assert.equal(classify(same, null, undefined), 'localOnly');
        assert.equal(classify(same, 'NOV 03 18:45', undefined), 'unknown');
    });

    it('does not report a controller change while the baseline has no date yet', () => {
        assert.equal(classify(same, 'NOV 05 09:12', { hash: same }), 'clean');
    });
});

describe('fileKey', () => {
    it('ignores case and surrounding slashes', () => {
        assert.equal(fileKey('/job/', 'main.jbi'), 'JOB/MAIN.JBI');
        assert.equal(fileKey('', 'X.JBI'), 'X.JBI');
    });
});
