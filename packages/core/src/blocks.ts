/**
 * Programming blocks: when they air, and what the channel workflow does about
 * it. Pure and deterministic (safe inside a workflow): local times are turned
 * into epoch seconds with Intl and the block's IANA time zone, so a block at
 * 07:00 stays at 07:00 across daylight-saving changes.
 *
 * The workflow's loop (workflows.ts) calls plan() at every wake:
 *   arm      a window LEAD_SEC before it starts, so the guide shows it ahead
 *   announce at the start (one notice on the guide banner)
 *   end      remove the window; regular programming resumes in progress
 * and sleeps with a durable timer until the next of those moments.
 */

import type { BlockWindow, Item, ProgrammingBlock } from './types';
import { seededShuffle } from './schedule';

/** How far ahead a block is armed (and shows on the guide). */
export const LEAD_SEC = 6 * 3600;
/** A start notice later than this after the start is skipped (the box was off). */
export const ANNOUNCE_GRACE_SEC = 10 * 60;

const DAY = 86_400;

// ── time zones ───────────────────────────────────────────────────────────────

/** Offset of `tz` from UTC at epoch `t`, seconds (e.g. -18000 for New York in winter). */
export function tzOffset(t: number, tz: string): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: tz,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	}).formatToParts(new Date(t * 1000));
	const n = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
	const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) / 1000;
	return asUtc - Math.floor(t);
}

/** Epoch seconds for a wall-clock time in `tz`. */
export function zonedEpoch(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
	const guess = Date.UTC(y, m - 1, d, hh, mm) / 1000;
	let t = guess - tzOffset(guess, tz);
	t = guess - tzOffset(t, tz); // second pass settles daylight-saving edges
	return t;
}

/** The local calendar date (y, m, d, weekday) of epoch `t` in `tz`. */
function localDate(t: number, tz: string): { y: number; m: number; d: number } {
	const shifted = new Date((t + tzOffset(t, tz)) * 1000);
	return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() };
}

export function validTimeZone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

// ── occurrences ──────────────────────────────────────────────────────────────

export interface Occurrence {
	key: string;
	block: ProgrammingBlock;
	startsAt: number;
	endsAt: number;
}

/** Occurrences of a block that overlap [fromSec, untilSec), in order. */
export function occurrences(block: ProgrammingBlock, fromSec: number, untilSec: number): Occurrence[] {
	const [hh, mm] = block.start.split(':').map(Number);
	const len = block.durationMin * 60;
	const make = (y: number, m: number, d: number): Occurrence => {
		const startsAt = zonedEpoch(y, m, d, hh, mm, block.tz);
		return { key: `${block.id}@${startsAt}`, block, startsAt, endsAt: startsAt + len };
	};
	const out: Occurrence[] = [];
	if (block.date) {
		const [y, m, d] = block.date.split('-').map(Number);
		const o = make(y, m, d);
		if (o.endsAt > fromSec && o.startsAt < untilSec) out.push(o);
		return out;
	}
	const days = new Set(block.days ?? []);
	// Walk local dates from a day before (a block can run past midnight) to the end.
	for (let t = fromSec - len - DAY; t < untilSec + DAY; t += DAY) {
		const { y, m, d } = localDate(t, block.tz);
		const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
		if (!days.has(weekday)) continue;
		const o = make(y, m, d);
		if (o.endsAt > fromSec && o.startsAt < untilSec && !out.some((x) => x.key === o.key)) out.push(o);
	}
	return out.sort((a, b) => a.startsAt - b.startsAt);
}

/** The next occurrences of every block, soonest first (for the agent and the docs). */
export function upcoming(blocks: ProgrammingBlock[] | undefined, nowSec: number, days = 14): Occurrence[] {
	return (blocks ?? []).flatMap((b) => occurrences(b, nowSec, nowSec + days * DAY)).sort((a, b) => a.startsAt - b.startsAt);
}

// ── what the workflow does now ───────────────────────────────────────────────

export interface BlockPlan {
	/** Occurrences to arm now (the workflow copies the shows for each, then calls arm()). */
	toArm: Occurrence[];
	/** Windows to keep (still ahead or on air). */
	keep: BlockWindow[];
	/** Windows that started just now and need their notice. */
	toAnnounce: BlockWindow[];
	/** When to wake next (epoch seconds), or null if no block is coming. */
	wakeAt: number | null;
}

/**
 * Compare what should be armed at `nowSec` with what is armed. Pure: the
 * workflow does the side effects (copy shows, post notices) and sleeps until
 * wakeAt. Overlapping occurrences: the one that starts first wins.
 */
export function plan(blocks: ProgrammingBlock[] | undefined, windows: BlockWindow[] | undefined, nowSec: number): BlockPlan {
	const horizon = nowSec + LEAD_SEC + 8 * DAY;
	const occ = (blocks ?? []).flatMap((b) => occurrences(b, nowSec - 2 * DAY, horizon)).sort((a, b) => a.startsAt - b.startsAt);
	const wanted = new Map<string, Occurrence>();
	let lastEnd = -Infinity;
	for (const o of occ) {
		if (o.startsAt < lastEnd) continue; // overlaps an earlier one
		lastEnd = o.endsAt;
		if (o.startsAt - LEAD_SEC <= nowSec && nowSec < o.endsAt) wanted.set(o.key, o);
	}
	const blockIds = new Set((blocks ?? []).map((b) => b.id));
	const keep = (windows ?? []).filter((w) => wanted.has(w.key) && blockIds.has(w.blockId));
	const armed = new Set(keep.map((w) => w.key));
	const toArm = [...wanted.values()].filter((o) => !armed.has(o.key));
	const toAnnounce = keep.filter((w) => !w.announced && w.startsAt <= nowSec && nowSec < w.startsAt + ANNOUNCE_GRACE_SEC);

	const moments: number[] = [];
	for (const o of occ) {
		for (const m of [o.startsAt - LEAD_SEC, o.startsAt, o.endsAt]) if (m > nowSec) moments.push(m);
	}
	return { toArm, keep, toAnnounce, wakeAt: moments.length ? Math.min(...moments) : null };
}

/** The window for an occurrence, with its own copy of the shows (shuffled per airing unless shuffle is false). */
export function arm(o: Occurrence, shows: Item[]): BlockWindow {
	const items = o.block.shuffle === false ? shows : seededShuffle(shows, o.startsAt);
	return {
		key: o.key,
		blockId: o.block.id,
		name: o.block.name,
		startsAt: o.startsAt,
		endsAt: o.endsAt,
		items: items.map((i) => ({ ...i, id: `${o.block.id}:${i.id}` }))
	};
}

// ── checks ───────────────────────────────────────────────────────────────────

export function blockProblem(b: ProgrammingBlock): string | null {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(b.id ?? '')) return 'block id must be lowercase kebab-case';
	if (!b.name?.trim() || b.name.length > 24) return 'block name must be 1–24 chars';
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(b.fromChannel ?? '')) return 'fromChannel must be a channel id';
	if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.start ?? '')) return 'start must be HH:MM (24-hour)';
	if (!Number.isInteger(b.durationMin) || b.durationMin < 15 || b.durationMin > 24 * 60) return 'durationMin must be 15–1440';
	if (!validTimeZone(b.tz ?? '')) return `unknown time zone "${b.tz}"`;
	const hasDays = Array.isArray(b.days) && b.days.length > 0;
	if (hasDays === !!b.date) return 'give either days (0 = Sunday … 6 = Saturday) or one date';
	if (hasDays && b.days!.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return 'days must be 0–6';
	if (b.date && !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return 'date must be YYYY-MM-DD';
	return null;
}
