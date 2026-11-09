import { describe, expect, it } from 'vitest';
import type { Channel, Item, LineupState } from '../src/types';
import * as M from '../src/mutations';
import { flatten, whatsOn } from '../src/schedule';
import { parseLength, playableFiles } from '../src/archive';

const item = (id: string, durationSec = 100): Item => ({
	id,
	title: id,
	durationSec,
	source: { kind: 'url', url: `https://example.com/${id}.mp4` }
});
const base = (): Channel => ({
	id: 'toon-lab',
	num: 7,
	name: 'TOON LAB',
	kind: 'playlist',
	anchorEpoch: 0,
	items: [item('a'), item('b'), item('c')]
});

describe('channel mutations', () => {
	it('adds items and keeps the current item on air', () => {
		const c = base();
		const now = 150; // 50s into b
		const next = M.addItems(c, { items: [item('x', 999)], at: 0 }, now);
		expect(next.items.map((i) => i.id)).toEqual(['x', 'a', 'b', 'c']);
		const on = whatsOn(flatten(next), now)!;
		expect(on.item.id).toBe('b');
		expect(on.offsetSec).toBeCloseTo(50, 9);
		expect(c.items).toHaveLength(3); // input untouched
	});

	it('rejects duplicate ids and bad sources', () => {
		expect(() => M.validateAddItems(base(), { items: [item('a')] })).toThrow(/duplicate/);
		expect(() =>
			M.validateAddItems(base(), { items: [{ ...item('z'), source: { kind: 'url', url: 'ftp://x' } }] })
		).toThrow(/http/);
		expect(() =>
			M.validateAddItems(base(), { items: [{ ...item('z'), source: { kind: 'local', path: '../etc/passwd' } }] })
		).toThrow(/media folder/);
	});

	it('removes and moves items by id', () => {
		const removed = M.removeItem(base(), { itemId: 'b' }, 0);
		expect(removed.items.map((i) => i.id)).toEqual(['a', 'c']);
		const moved = M.moveItem(base(), { itemId: 'c', to: 0 }, 0);
		expect(moved.items.map((i) => i.id)).toEqual(['c', 'a', 'b']);
		expect(() => M.validateMoveItem(base(), { itemId: 'nope', to: 0 })).toThrow(/no item/);
		expect(() => M.validateMoveItem(base(), { itemId: 'a', to: 3 })).toThrow(/out of range/);
	});

	it('uppercases names and checks the patch', () => {
		expect(M.updateChannel(base(), { patch: { name: 'nite owl' } }).name).toBe('NITE OWL');
		expect(() => M.validateUpdateChannel(base(), { patch: {} })).toThrow(/at least one/);
		expect(() => M.validateUpdateChannel(base(), { patch: { num: 0 } })).toThrow(/1–999/);
		expect(() => M.validateUpdateChannel(base(), { patch: { name: 'X'.repeat(30) } })).toThrow(/≤ 24/);
	});

	it('rejects a whole channel with duplicate item ids', () => {
		expect(() => M.assertChannel({ ...base(), items: [item('a'), item('a')] })).toThrow(/duplicate/);
	});

	it('requires a card kind on card channels', () => {
		expect(() => M.validateUpdateChannel(base(), { patch: { kind: 'card' } })).toThrow(/card channels/);
	});

	it('sorts bubbles and rejects long or late ones', () => {
		const next = M.setBubbles(base(), {
			itemId: 'a',
			bubbles: [
				{ atSec: 50, text: 'second' },
				{ atSec: 10, text: 'first' }
			]
		});
		expect(next.items[0].bubbles!.map((b) => b.text)).toEqual(['first', 'second']);
		expect(() => M.validateSetBubbles(base(), { itemId: 'a', bubbles: [{ atSec: 1, text: 'x'.repeat(91) }] })).toThrow(/≤ 90/);
		expect(() => M.validateSetBubbles(base(), { itemId: 'a', bubbles: [{ atSec: 100, text: 'late' }] })).toThrow(/past the end/);
	});

	it('re-anchors when shuffle rules change the order', () => {
		const items = 'abcdefgh'.split('').map((id) => item(id, 60));
		const c: Channel = { ...base(), items };
		const now = 200; // 20s into d
		const next = M.setRules(c, { rules: { shuffleSeed: 9 } }, now);
		const on = whatsOn(flatten(next), now)!;
		expect(on.item.id).toBe('d');
		expect(on.offsetSec).toBeCloseTo(20, 9);
	});
});

describe('lineup mutations', () => {
	const lineup = (): LineupState => ({ boxName: 'BOX', channelIds: ['a'], notices: [] });

	it('adds and removes channel ids', () => {
		expect(M.addChannel(lineup(), { id: 'b' }).channelIds).toEqual(['a', 'b']);
		expect(() => M.validateAddChannel(lineup(), { id: 'a' })).toThrow(/already/);
		expect(M.removeChannel(lineup(), { id: 'a' }).channelIds).toEqual([]);
	});

	it('puts the newest notice first and replaces by id', () => {
		const n = (id: string) => ({ id, headline: id, body: '', kind: 'info' as const, createdAt: 0 });
		let l = M.postNotice(lineup(), { notice: n('1') });
		l = M.postNotice(l, { notice: n('2') });
		l = M.postNotice(l, { notice: n('1') });
		expect(l.notices.map((x) => x.id)).toEqual(['1', '2']);
	});
});

describe('archive helpers', () => {
	it('parses lengths', () => {
		expect(parseLength('554.99')).toBeCloseTo(554.99);
		expect(parseLength('01:02:03')).toBe(3723);
		expect(parseLength('12:05')).toBe(725);
		expect(parseLength(undefined)).toBe(0);
	});

	it('picks the best derivative per original, one per episode', () => {
		const files = playableFiles({
			identifier: 'x',
			collection: [],
			files: [
				{ name: 'ep2.mpeg', source: 'original', format: 'MPEG2', title: 'Episode Two' },
				{ name: 'ep2.mp4', source: 'derivative', original: 'ep2.mpeg', format: '512Kb MPEG4', length: '600' },
				{ name: 'ep2.ia.mp4', source: 'derivative', original: 'ep2.mpeg', format: 'h.264 IA', length: '600.5' },
				{ name: 'ep10.mp4', source: 'original', format: 'MPEG4', length: '300' },
				{ name: 'ep10.mp3', source: 'derivative', original: 'ep10.mp4', format: 'VBR MP3', length: '300' },
				{ name: 'cover.jpg', source: 'original', format: 'JPEG' }
			]
		});
		expect(files.map((f) => f.file)).toEqual(['ep2.ia.mp4', 'ep10.mp4']);
		expect(files[0].title).toBe('Episode Two');
		expect(files[0].durationSec).toBeCloseTo(600.5);
	});
});

describe('health check repairs', () => {
	it('takes dead items off the air and swaps repaired sources', () => {
		const c = base();
		const next = M.repairItems(
			c,
			{ dead: ['b'], replace: [{ itemId: 'c', source: { kind: 'url', url: 'https://example.com/new.mp4' }, durationSec: 120 }] },
			0
		);
		const flat = flatten(next);
		expect(flat.items.map((i) => i.id)).toEqual(['a', 'c']);
		expect(flat.items[1].url).toBe('https://example.com/new.mp4');
		expect(flat.totalSec).toBe(220);
		const back = M.repairItems(next, { alive: ['b'] }, 0);
		expect(flatten(back).items).toHaveLength(3);
	});
});

describe('live channels', () => {
	const base = { id: 'rw', num: 40, name: 'RW', kind: 'live' as const, anchorEpoch: 0 };
	const stream = { id: 'stream', title: 'RW', source: { kind: 'hls' as const, url: 'https://x/live.m3u8' }, durationSec: 0 };
	it('needs exactly one hls item', () => {
		expect(() => M.assertChannel({ ...base, items: [stream] })).not.toThrow();
		expect(() => M.assertChannel({ ...base, items: [] })).toThrow(/exactly one hls item/);
		expect(() => M.assertChannel({ ...base, items: [{ ...stream, source: { kind: 'url', url: 'https://x/a.mp4' } }] })).toThrow(/exactly one hls item/);
	});
	it('checks the guide data URL', () => {
		expect(() => M.assertChannel({ ...base, items: [stream], live: { epgUrl: 'ftp://nope' } })).toThrow(/epgUrl/);
	});
});
