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

export function flatten(channel: Pick<Channel, 'id' | 'anchorEpoch' | 'items' | 'rules'>): FlatSchedule {
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
	return { channelId: channel.id, anchorEpoch: channel.anchorEpoch, totalSec: start, items };
}

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

/** What is on at `nowSec`, or null if the channel has nothing to air. */
export function whatsOn(flat: FlatSchedule, nowSec: number): Airing | null {
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
	const first = whatsOn(flat, fromSec);
	if (!first) return [];
	const out: Airing[] = [first];
	let { index, endsAt } = first;
	while (endsAt < untilSec && out.length < max) {
		index = (index + 1) % flat.items.length;
		const item = flat.items[index];
		out.push({ index, item, offsetSec: 0, startsAt: endsAt, endsAt: endsAt + item.durationSec });
		endsAt += item.durationSec;
	}
	return out;
}

/**
 * New anchor after the channel's items change, chosen so the item on air now
 * keeps playing from the same spot. If that item was removed, the item that
 * now sits in its position starts from the top at `nowSec`.
 */
export function reanchor(before: FlatSchedule, after: FlatSchedule, nowSec: number): number {
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
