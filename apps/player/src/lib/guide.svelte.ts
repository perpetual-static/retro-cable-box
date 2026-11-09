/**
 * Guide data from the API, polled. Also keeps the box clock: `now()` is the
 * server's time, so every TV on the box agrees on what is on.
 */

import { airings, liveAirings, type Airing, type EpgProgram, type FlatSchedule } from '@box/core';

export interface GuideChannel {
	id: string;
	num: number;
	name: string;
	kind: 'playlist' | 'live' | 'card';
	card?: 'clock' | 'standby' | 'notices';
	blurb?: string;
	category?: string;
}

export interface Notice {
	id: string;
	headline: string;
	body: string;
	kind: 'update' | 'info' | 'warning';
	createdAt: number;
}

export interface GuideData {
	boxName: string;
	serverTime: number;
	channels: GuideChannel[];
	schedules: Record<string, FlatSchedule>;
	/** Live channels: stream URL and guide data (programs). */
	live?: Record<string, { url: string | null; logo?: string; programs: EpgProgram[] }>;
	notices: Notice[];
}

const POLL_MS = 10_000;

class Guide {
	data = $state<GuideData | null>(null);
	error = $state<string | null>(null);
	/** Seconds to add to the local clock to get the box clock. */
	offset = 0;
	#timer: ReturnType<typeof setInterval> | undefined;

	async refresh(): Promise<void> {
		const sent = Date.now();
		try {
			const res = await fetch('/api/guide');
			const body = await res.json();
			if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
			const rtt = (Date.now() - sent) / 1000;
			this.offset = body.serverTime + rtt / 2 - Date.now() / 1000;
			body.channels.sort((a: GuideChannel, b: GuideChannel) => a.num - b.num);
			this.data = body;
			this.error = null;
		} catch (err) {
			this.error = (err as Error).message;
		}
	}

	start(): void {
		if (this.#timer) return;
		void this.refresh();
		this.#timer = setInterval(() => void this.refresh(), POLL_MS);
	}

	channel(id: string | undefined): GuideChannel | undefined {
		return this.data?.channels.find((c) => c.id === id);
	}
}

export const guide = new Guide();

/** What airs on a channel in [from, until): the shared clock for playlists, guide data for live channels. */
export function channelAirings(c: GuideChannel, from: number, until: number, max = 40): Airing[] {
	const d = guide.data;
	if (!d || c.kind === 'card') return [];
	if (c.kind === 'live') {
		const l = d.live?.[c.id];
		return l?.url ? liveAirings(l.url, c.name, l.programs, from, until, max) : [];
	}
	const flat = d.schedules[c.id];
	return flat ? airings(flat, from, until, max) : [];
}

/** True when the channel has something to put on screen. */
export function onAir(c: GuideChannel): boolean {
	if (c.kind === 'card') return true;
	if (c.kind === 'live') return !!guide.data?.live?.[c.id]?.url;
	return (guide.data?.schedules[c.id]?.totalSec ?? 0) > 0;
}

/** Box time, epoch seconds. */
export const now = (): number => Date.now() / 1000 + guide.offset;

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', opts);
const timeFmt = fmt({ hour: 'numeric', minute: '2-digit' });
const dateFmt = fmt({ weekday: 'short', month: 'short', day: 'numeric' });

export const clockText = (sec: number): string => timeFmt.format(new Date(sec * 1000));
export const dateText = (sec: number): string => dateFmt.format(new Date(sec * 1000)).toUpperCase();
export const pad2 = (n: number): string => String(n).padStart(2, '0');
