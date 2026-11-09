import { describe, expect, it } from 'vitest';
import { arm, blockProblem, LEAD_SEC, occurrences, plan, tzOffset, zonedEpoch } from '../src/blocks';
import { airings, flatten, whatsOn } from '../src/schedule';
import { setBlock, validateSetBlock } from '../src/mutations';
import type { Channel, Item, ProgrammingBlock } from '../src/types';

const NY = 'America/New_York';
const iso = (t: number): string => new Date(t * 1000).toISOString();
const item = (id: string, sec: number): Item => ({ id, title: id.toUpperCase(), durationSec: sec, source: { kind: 'url', url: `https://media.example/${id}.mp4` } });

const SAT_TOONS: ProgrammingBlock = { id: 'sat-toons', name: 'SATURDAY MORNING', fromChannel: 'toon-lab', days: [6], start: '07:00', durationMin: 240, tz: NY };

describe('time zones', () => {
	it('knows New York in winter and summer', () => {
		expect(tzOffset(Date.UTC(2026, 0, 15) / 1000, NY)).toBe(-5 * 3600);
		expect(tzOffset(Date.UTC(2026, 6, 15) / 1000, NY)).toBe(-4 * 3600);
	});
	it('keeps 07:00 local across the daylight-saving change', () => {
		// Saturday Oct 31 2026 is EDT (UTC-4); Saturday Nov 7 2026 is EST (UTC-5).
		expect(iso(zonedEpoch(2026, 10, 31, 7, 0, NY))).toBe('2026-10-31T11:00:00.000Z');
		expect(iso(zonedEpoch(2026, 11, 7, 7, 0, NY))).toBe('2026-11-07T12:00:00.000Z');
	});
});

describe('occurrences', () => {
	it('finds each Saturday at 07:00 local for 4 hours', () => {
		const from = Date.UTC(2026, 9, 26) / 1000; // Mon Oct 26
		const os = occurrences(SAT_TOONS, from, from + 14 * 86_400);
		expect(os.map((o) => iso(o.startsAt))).toEqual(['2026-10-31T11:00:00.000Z', '2026-11-07T12:00:00.000Z']);
		expect(os[0].endsAt - os[0].startsAt).toBe(4 * 3600);
		expect(os[0].key).toBe(`sat-toons@${os[0].startsAt}`);
	});
	it('finds a one-off date, and nothing outside the range', () => {
		const b: ProgrammingBlock = { ...SAT_TOONS, days: undefined, date: '2026-10-31', start: '20:00', durationMin: 180 };
		const t = zonedEpoch(2026, 10, 31, 20, 0, NY);
		expect(occurrences(b, t - 86_400, t + 86_400).map((o) => o.startsAt)).toEqual([t]);
		expect(occurrences(b, t + 4 * 3600, t + 86_400)).toEqual([]);
	});
});

describe('plan (what the workflow does at each wake)', () => {
	const start = zonedEpoch(2026, 11, 14, 7, 0, NY);
	const end = start + 4 * 3600;

	it('sleeps until the arm time when nothing is near', () => {
		const p = plan([SAT_TOONS], [], start - 2 * 86_400);
		expect(p.toArm).toEqual([]);
		expect(p.wakeAt).toBe(start - LEAD_SEC);
	});
	it('arms 6 hours ahead, then wakes at the start', () => {
		const p = plan([SAT_TOONS], [], start - LEAD_SEC);
		expect(p.toArm.map((o) => o.startsAt)).toEqual([start]);
		expect(p.wakeAt).toBe(start);
	});
	it('announces at the start, then wakes at the end', () => {
		const w = arm(plan([SAT_TOONS], [], start - LEAD_SEC).toArm[0], [item('a', 600)]);
		const p = plan([SAT_TOONS], [w], start);
		expect(p.toArm).toEqual([]);
		expect(p.toAnnounce.map((x) => x.key)).toEqual([w.key]);
		expect(p.wakeAt).toBe(end);
	});
	it('drops the window at the end and looks to next week', () => {
		const w = { ...arm(plan([SAT_TOONS], [], start).toArm[0], [item('a', 600)]), announced: true };
		const p = plan([SAT_TOONS], [w], end);
		expect(p.keep).toEqual([]);
		expect(p.wakeAt).toBe(start + 7 * 86_400 - LEAD_SEC);
	});
	it('catches up after the box was off: arms late, skips a stale notice', () => {
		const p = plan([SAT_TOONS], [], start + 3600);
		expect(p.toArm.map((o) => o.startsAt)).toEqual([start]);
		const w = arm(p.toArm[0], [item('a', 600)]);
		expect(plan([SAT_TOONS], [w], start + 3600).toAnnounce).toEqual([]);
	});
	it('drops windows of a removed block', () => {
		const w = arm(plan([SAT_TOONS], [], start).toArm[0], [item('a', 600)]);
		expect(plan([], [w], start + 60).keep).toEqual([]);
	});
});

describe('schedule windows', () => {
	const t0 = 1_000_000;
	const base = { id: 'ch', anchorEpoch: t0, items: [item('news', 1800)] };
	const window = { key: 'b@x', blockId: 'b', name: 'BLOCK', startsAt: t0 + 900, endsAt: t0 + 900 + 1200, items: [item('toon', 400)] };
	const flat = flatten({ ...base, windows: [window] });

	it('airs the block inside its window, from its first item', () => {
		const a = whatsOn(flat, t0 + 900 + 10)!;
		expect(a.item.id).toBe('toon');
		expect(a.offsetSec).toBe(10);
	});
	it('cuts the regular show at the window edge, and resumes it in progress after', () => {
		const before = whatsOn(flat, t0 + 600)!;
		expect(before.item.id).toBe('news');
		expect(before.endsAt).toBe(t0 + 900);
		const after = whatsOn(flat, t0 + 2100 + 5)!;
		expect(after.item.id).toBe('news');
		expect(after.offsetSec).toBe(2105 % 1800);
		expect(after.startsAt).toBe(t0 + 2100);
	});
	it('gives the guide a clean run across the block', () => {
		const run = airings(flat, t0, t0 + 2400).map((a) => [a.item.id, a.startsAt - t0, a.endsAt - t0]);
		expect(run).toEqual([
			['news', 0, 900],
			['toon', 900, 1300],
			['toon', 1300, 1700],
			['toon', 1700, 2100],
			['news', 2100, 3600]
		]);
	});
	it('arm() copies the shows with ids of their own', () => {
		const o = occurrences(SAT_TOONS, zonedEpoch(2026, 11, 14, 0, 0, NY), zonedEpoch(2026, 11, 15, 0, 0, NY))[0];
		const w = arm(o, [item('a', 60), item('b', 60), item('c', 60)]);
		expect(w.items.every((i) => i.id.startsWith('sat-toons:'))).toBe(true);
		expect(w.items).toHaveLength(3);
	});
});

describe('block validation', () => {
	const ch: Channel = { id: 'matinee', num: 6, name: 'MATINEE', kind: 'playlist', anchorEpoch: 0, items: [] };
	it('accepts a good block and stores it', () => {
		expect(() => validateSetBlock(ch, { block: SAT_TOONS })).not.toThrow();
		expect(setBlock(ch, { block: SAT_TOONS }).blocks).toHaveLength(1);
	});
	it('says what is wrong', () => {
		expect(blockProblem({ ...SAT_TOONS, start: '7am' })).toMatch(/HH:MM/);
		expect(blockProblem({ ...SAT_TOONS, tz: 'Mars/Olympus' })).toMatch(/time zone/);
		expect(blockProblem({ ...SAT_TOONS, date: '2026-10-31' })).toMatch(/either days/);
		expect(() => validateSetBlock(ch, { block: { ...SAT_TOONS, fromChannel: 'matinee' } })).toThrow(/another channel/);
	});
});
