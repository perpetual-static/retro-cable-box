import { describe, expect, it } from 'vitest';
import type { Channel, Item } from '../src/types';
import {
	airings,
	anchorForItemAt,
	flatten,
	normalizeAnchor,
	playableUrl,
	reanchor,
	seededShuffle,
	whatsOn
} from '../src/schedule';

const item = (id: string, durationSec: number, extra: Partial<Item> = {}): Item => ({
	id,
	title: id.toUpperCase(),
	durationSec,
	source: { kind: 'url', url: `https://example.com/${id}.mp4` },
	...extra
});

const channel = (items: Item[], anchorEpoch = 1000, rules?: Channel['rules']): Channel => ({
	id: 'test',
	num: 3,
	name: 'TEST',
	kind: 'playlist',
	anchorEpoch,
	items,
	rules
});

// a: 0–100, b: 100–250, c: 250–300; loop = 300s
const abc = () => [item('a', 100), item('b', 150), item('c', 50)];

describe('flatten', () => {
	it('lays items end to end and sums the loop', () => {
		const f = flatten(channel(abc()));
		expect(f.totalSec).toBe(300);
		expect(f.items.map((i) => i.start)).toEqual([0, 100, 250]);
	});

	it('leaves out items that have no duration or no playable url', () => {
		const f = flatten(
			channel([item('a', 100), item('zero', 0), item('arch', 60, { source: { kind: 'archive', identifier: 'x' } })])
		);
		expect(f.items.map((i) => i.id)).toEqual(['a']);
	});

	it('is empty for a channel with nothing to air', () => {
		expect(flatten(channel([])).totalSec).toBe(0);
	});
});

describe('whatsOn', () => {
	const f = flatten(channel(abc(), 1000));

	it('finds the item and the offset into it', () => {
		const on = whatsOn(f, 1000 + 120)!;
		expect(on.item.id).toBe('b');
		expect(on.offsetSec).toBe(20);
		expect(on.startsAt).toBe(1100);
		expect(on.endsAt).toBe(1250);
	});

	it('treats an item boundary as the start of the next item', () => {
		expect(whatsOn(f, 1100)!.item.id).toBe('b');
		expect(whatsOn(f, 1100)!.offsetSec).toBe(0);
	});

	it('wraps around the loop', () => {
		const on = whatsOn(f, 1000 + 300 * 7 + 260)!;
		expect(on.item.id).toBe('c');
		expect(on.offsetSec).toBe(10);
	});

	it('works for times before the anchor', () => {
		const on = whatsOn(f, 1000 - 10)!; // 290 into the previous loop
		expect(on.item.id).toBe('c');
		expect(on.offsetSec).toBe(40);
	});

	it('handles fractional durations without drifting', () => {
		const g = flatten(channel([item('x', 33.37), item('y', 66.63)], 0));
		const on = whatsOn(g, 100 * 1000 + 40)!;
		expect(on.item.id).toBe('y');
		expect(on.offsetSec).toBeCloseTo(6.63, 6);
	});

	it('returns null when nothing can air', () => {
		expect(whatsOn(flatten(channel([])), 5)).toBeNull();
	});
});

describe('airings', () => {
	it('lists everything that overlaps the window', () => {
		const f = flatten(channel(abc(), 0));
		const list = airings(f, 50, 401);
		expect(list.map((a) => a.item.id)).toEqual(['a', 'b', 'c', 'a', 'b']);
		expect(list[0].startsAt).toBe(0);
		expect(list[3].startsAt).toBe(300);
	});

	it('caps the list', () => {
		const f = flatten(channel([item('tiny', 1)], 0));
		expect(airings(f, 0, 10_000, 20)).toHaveLength(20);
	});
});

describe('reanchor', () => {
	const now = 1000 + 120; // 20s into b

	it('keeps the current item playing from the same spot after an insert before it', () => {
		const before = channel(abc(), 1000);
		const after = channel([item('new', 500), ...abc()], 1000);
		after.anchorEpoch = reanchor(flatten(before), flatten(after), now);
		const on = whatsOn(flatten(after), now)!;
		expect(on.item.id).toBe('b');
		expect(on.offsetSec).toBeCloseTo(20, 9);
	});

	it('keeps the current item after a reorder', () => {
		const before = channel(abc(), 1000);
		const [a, b, c] = abc();
		const after = channel([c, b, a], 1000);
		after.anchorEpoch = reanchor(flatten(before), flatten(after), now);
		const on = whatsOn(flatten(after), now)!;
		expect(on.item.id).toBe('b');
		expect(on.offsetSec).toBeCloseTo(20, 9);
	});

	it('starts the item that took its place when the current item is removed', () => {
		const before = channel(abc(), 1000);
		const [a, , c] = abc();
		const after = channel([a, c], 1000);
		after.anchorEpoch = reanchor(flatten(before), flatten(after), now);
		const on = whatsOn(flatten(after), now)!;
		expect(on.item.id).toBe('c');
		expect(on.offsetSec).toBeCloseTo(0, 9);
	});

	it('starts at the top when the channel was empty', () => {
		const after = flatten(channel(abc(), 0));
		expect(reanchor(flatten(channel([])), after, 5000)).toBe(5000);
	});

	it('keeps the anchor in (now - total, now]', () => {
		const a = normalizeAnchor(-1_000_000, 300, 5000);
		expect(a).toBeLessThanOrEqual(5000);
		expect(a).toBeGreaterThan(5000 - 300);
	});
});

describe('anchorForItemAt', () => {
	it('makes an item start at a given time', () => {
		const f = flatten(channel(abc(), 0));
		const at = 1_700_000_000;
		const anchor = anchorForItemAt(f, 'c', at)!;
		const on = whatsOn({ ...f, anchorEpoch: anchor }, at)!;
		expect(on.item.id).toBe('c');
		expect(on.offsetSec).toBe(0);
	});
});

describe('shuffle', () => {
	it('is deterministic for a seed and keeps every item', () => {
		const list = [1, 2, 3, 4, 5, 6, 7, 8];
		expect(seededShuffle(list, 42)).toEqual(seededShuffle(list, 42));
		expect([...seededShuffle(list, 42)].sort()).toEqual(list);
		expect(seededShuffle(list, 42)).not.toEqual(seededShuffle(list, 7));
	});

	it('changes the air order when a seed is set', () => {
		const items = 'abcdefghij'.split('').map((id) => item(id, 10));
		const plain = flatten(channel(items)).items.map((i) => i.id);
		const shuffled = flatten(channel(items, 0, { shuffleSeed: 3 })).items.map((i) => i.id);
		expect(shuffled).not.toEqual(plain);
	});
});

describe('playableUrl', () => {
	it('builds archive.org download urls with encoded file names', () => {
		expect(playableUrl({ kind: 'archive', identifier: 'abc', file: 'dir/My Film.mp4' })).toBe(
			'https://archive.org/download/abc/dir/My%20Film.mp4'
		);
	});
	it('maps local files under /media', () => {
		expect(playableUrl({ kind: 'local', path: 'toons/ep 1.mp4' })).toBe('/media/toons/ep%201.mp4');
	});
});
