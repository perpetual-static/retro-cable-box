/**
 * Shared-clock math. The one place a bug is embarrassing, so it is pure and
 * fully unit-tested. Used by the player, the API, the MCP server and the
 * channel workflow (for re-anchoring), so "what's on" is the same everywhere.
 *
 *   position = (now - anchor) mod totalDuration
 *
 * then walk the cumulative durations to find the item and the offset into it.
 */

import type { Bubble, Channel, Item, Source } from './types';

export interface ScheduledItem {
	id: string;
	title: string;
	durationSec: number;
	/** Offset of this item from the start of the loop, seconds. */
	start: number;
	/** Playable URL, or null if the source is not resolved yet. */
	url: string | null;
	sourceKind: Source['kind'];
	year?: number;
	bubbles?: Bubble[];
}

export interface FlatSchedule {
	channelId: string;
	anchorEpoch: number;
	/** Length of one full loop, seconds. 0 means nothing can air. */
	totalSec: number;
	items: ScheduledItem[];
	/**
	 * Programming blocks the channel workflow has armed: stretches of time
	 * where another loop airs instead (sorted, no overlaps). Outside them the
	 * regular loop airs, already in progress, like real TV.
	 */
	windows?: ScheduleWindow[];
}

export interface ScheduleWindow {
	blockId: string;
	name: string;
	startsAt: number;
	endsAt: number;
	/** The block's own loop, anchored at startsAt so it opens with its first item. */
	flat: FlatSchedule;
}

export interface Airing {
	index: number;
	item: ScheduledItem;
	/** Seconds into the item at the given time. */
	offsetSec: number;
	/** Epoch seconds the item started / will end. */
	startsAt: number;
	endsAt: number;
}

/** Turn a source into a URL a <video> element can play. */
export function playableUrl(source: Source): string | null {
	switch (source.kind) {
		case 'archive':
			if (!source.file) return null;
			return `https://archive.org/download/${encodeURIComponent(source.identifier)}/${source.file
				.split('/')
				.map(encodeURIComponent)
				.join('/')}`;
		case 'url':
			return source.url;
		case 'local':
			return `/media/${source.path.split('/').map(encodeURIComponent).join('/')}`;
		case 'hls':
			return source.url;
	}
}

/** Deterministic PRNG (mulberry32) so a shuffle seed always gives the same order. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function seededShuffle<T>(list: readonly T[], seed: number): T[] {
	const out = [...list];
	const rand = mulberry32(seed);
	for (let i = out.length - 1; i > 0; i -= 1) {
		const j = Math.floor(rand() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/** Items in air order: list order, or a seeded shuffle. Unresolved items are left out. */
export function airOrder(channel: Pick<Channel, 'items' | 'rules'>): Item[] {
	const ready = channel.items.filter((i) => !i.dead && i.durationSec > 0 && playableUrl(i.source) !== null);
	const seed = channel.rules?.shuffleSeed;
	return seed === undefined ? ready : seededShuffle(ready, seed);
}

export function flatten(channel: Pick<Channel, 'id' | 'anchorEpoch' | 'items' | 'rules' | 'windows'>): FlatSchedule {
	let start = 0;
	const items: ScheduledItem[] = airOrder(channel).map((i) => {
		const s: ScheduledItem = {
			id: i.id,
			title: i.title,
			durationSec: i.durationSec,
			start,
			url: playableUrl(i.source),
			sourceKind: i.source.kind,
			year: i.year,
			bubbles: i.bubbles
		};
		start += i.durationSec;
		return s;
	});
	const flat: FlatSchedule = { channelId: channel.id, anchorEpoch: channel.anchorEpoch, totalSec: start, items };
	const windows = (channel.windows ?? [])
		.filter((w) => w.endsAt > w.startsAt)
		.map((w) => ({
			blockId: w.blockId,
			name: w.name,
			startsAt: w.startsAt,
			endsAt: w.endsAt,
			flat: flatten({ id: channel.id, anchorEpoch: w.startsAt, items: w.items })
		}))
		.filter((w) => w.flat.totalSec > 0)
		.sort((a, b) => a.startsAt - b.startsAt);
	if (windows.length) flat.windows = windows;
	return flat;
}

/** The loop without its block windows (re-anchoring works on the regular loop only). */
export const baseLoop = (flat: FlatSchedule): FlatSchedule => (flat.windows ? { ...flat, windows: undefined } : flat);

/** Position within the loop at `nowSec`, always in [0, totalSec). */
export function loopPosition(flat: FlatSchedule, nowSec: number): number {
	const t = flat.totalSec;
	return (((nowSec - flat.anchorEpoch) % t) + t) % t;
}

/** Index of the item that contains loop position `pos` (binary search). */
function indexAt(flat: FlatSchedule, pos: number): number {
	let lo = 0;
	let hi = flat.items.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (flat.items[mid].start <= pos) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/**
 * What is on at `nowSec`, or null if the channel has nothing to air. Inside a
 * block window the block's loop airs; an airing that runs into a window edge
 * is cut at the edge (startsAt / endsAt), and offsetSec stays the offset into
 * the file.
 */
export function whatsOn(flat: FlatSchedule, nowSec: number): Airing | null {
	const ws = flat.windows;
	if (!ws?.length) return loopAt(flat, nowSec);
	const w = ws.find((x) => x.startsAt <= nowSec && nowSec < x.endsAt);
	if (w) {
		const a = loopAt(w.flat, nowSec);
		if (a) return clip(a, w.startsAt, w.endsAt);
	}
	const a = loopAt(flat, nowSec);
	if (!a) return null;
	const before = ws.filter((x) => x.endsAt <= nowSec).reduce((m, x) => Math.max(m, x.endsAt), -Infinity);
	const after = ws.filter((x) => x.startsAt > nowSec).reduce((m, x) => Math.min(m, x.startsAt), Infinity);
	return clip(a, before, after);
}

function clip(a: Airing, from: number, until: number): Airing {
	if (a.startsAt >= from && a.endsAt <= until) return a;
	return { ...a, startsAt: Math.max(a.startsAt, from), endsAt: Math.min(a.endsAt, until) };
}

function loopAt(flat: FlatSchedule, nowSec: number): Airing | null {
	if (flat.totalSec <= 0 || flat.items.length === 0) return null;
	const pos = loopPosition(flat, nowSec);
	const index = indexAt(flat, pos);
	const item = flat.items[index];
	const offsetSec = pos - item.start;
	const startsAt = nowSec - offsetSec;
	return { index, item, offsetSec, startsAt, endsAt: startsAt + item.durationSec };
}

/**
 * Every airing that overlaps [fromSec, untilSec), in order. The first entry may
 * have started before `fromSec`. Capped so a channel of 1-second clips can't
 * produce an unbounded list.
 */
export function airings(flat: FlatSchedule, fromSec: number, untilSec: number, max = 500): Airing[] {
	const out: Airing[] = [];
	let t = fromSec;
	while (t < untilSec && out.length < max) {
		const a = whatsOn(flat, t);
		if (!a) break;
		// Rounding can put t a hair before an item boundary: step over the sliver.
		if (a.endsAt - t < 1e-3) {
			t = a.endsAt + 1e-3;
			continue;
		}
		out.push(a);
		t = a.endsAt;
	}
	return out;
}

/**
 * New anchor after the channel's items change, chosen so the item on air now
 * keeps playing from the same spot. If that item was removed, the item that
 * now sits in its position starts from the top at `nowSec`.
 */
export function reanchor(beforeFlat: FlatSchedule, afterFlat: FlatSchedule, nowSec: number): number {
	const before = baseLoop(beforeFlat);
	const after = baseLoop(afterFlat);
	if (after.totalSec <= 0) return nowSec;
	const current = whatsOn(before, nowSec);
	let anchor: number;
	if (!current) {
		anchor = nowSec;
	} else {
		const same = after.items.find((i) => i.id === current.item.id);
		if (same) {
			anchor = nowSec - current.offsetSec - same.start;
		} else {
			const k = Math.min(current.index, after.items.length - 1);
			anchor = nowSec - after.items[k].start;
		}
	}
	return normalizeAnchor(anchor, after.totalSec, nowSec);
}

/** Same schedule, anchor moved into (now - total, now] so the number stays readable. */
export function normalizeAnchor(anchor: number, totalSec: number, nowSec: number): number {
	if (totalSec <= 0) return anchor;
	const k = Math.floor((nowSec - anchor) / totalSec);
	return anchor + k * totalSec;
}

/**
 * Anchor that makes item `itemId` start at `atSec` (e.g. "make the pilot air
 * at 8pm Saturday"). Returns null if the item is not in the schedule.
 */
export function anchorForItemAt(flat: FlatSchedule, itemId: string, atSec: number): number | null {
	const item = flat.items.find((i) => i.id === itemId);
	if (!item) return null;
	return atSec - item.start;
}
