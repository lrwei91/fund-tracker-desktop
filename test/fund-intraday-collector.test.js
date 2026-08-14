import { describe, expect, it } from 'vitest';
import {
    isCollectionMinute, normalizeCodes, normalizeRealtime, shanghaiClock, splitBatches,
} from '../services/fund-intraday-collector/src/core.mjs';

describe('fund intraday collector core', () => {
    it('validates, deduplicates and limits installation codes', () => {
        const values = ['110022', 'bad', '110022', ...Array.from({ length: 40 }, (_, index) => String(index).padStart(6, '0'))];
        const codes = normalizeCodes(values);
        expect(codes).toHaveLength(30);
        expect(codes[0]).toBe('110022');
        expect(new Set(codes).size).toBe(codes.length);
    });

    it('collects only weekday morning and afternoon sessions in Shanghai', () => {
        expect(isCollectionMinute(new Date('2026-08-13T10:00:00+08:00'))).toBe(true);
        expect(isCollectionMinute(new Date('2026-08-13T12:00:00+08:00'))).toBe(false);
        expect(isCollectionMinute(new Date('2026-08-15T10:00:00+08:00'))).toBe(false);
        expect(shanghaiClock(new Date('2026-08-13T01:30:00Z')).date).toBe('2026-08-13');
    });

    it('keeps valid partial upstream results and splits batches', () => {
        expect(normalizeRealtime({ 110022: 0.2, 110023: 99, 110024: null }, ['110022', '110023', '110024']))
            .toEqual([{ code: '110022', value: 0.2 }]);
        expect(splitBatches(Array.from({ length: 205 }), 100).map((batch) => batch.length)).toEqual([100, 100, 5]);
    });
});
