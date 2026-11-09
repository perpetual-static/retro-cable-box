/**
 * Live channels: M3U playlists in, XMLTV guide data in, airings out.
 *
 * Works with any IPTV-style source: free ad-supported services (through
 * community playlist tools), iptv-org, HDHomeRun, ErsatzTV / Tunarr. The box
 * never names a service; the user supplies the playlist URL.
 *
 * Browser-safe (no Node imports): the player uses liveAirings().
 */

import type { Airing, ScheduledItem } from './schedule';
import type { EpgProgram } from './types';

// ── M3U ──────────────────────────────────────────────────────────────────────

export interface M3uEntry {
	name: string;
	url: string;
	tvgId?: string;
	logo?: string;
	group?: string;
	/** Channel number the playlist suggests (tvg-chno / channel-number). */
	chno?: number;
}

export interface M3uPlaylist {
	/** Guide data URL from the #EXTM3U header (url-tvg / x-tvg-url), if any. */
	epgUrl?: string;
	entries: M3uEntry[];
}

const ATTR = /([a-zA-Z0-9-]+)="([^"]*)"/g;

function attrs(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of text.matchAll(ATTR)) out[m[1].toLowerCase()] = m[2];
	return out;
}

/** Splits the #EXTINF line at the comma that ends the attributes (commas can appear inside quotes). */
function splitExtinf(line: string): { head: string; name: string } {
	let quoted = false;
	for (let i = 0; i < line.length; i += 1) {
		const ch = line[i];
		if (ch === '"') quoted = !quoted;
		else if (ch === ',' && !quoted) return { head: line.slice(0, i), name: line.slice(i + 1).trim() };
	}
	return { head: line, name: '' };
}

export function parseM3u(text: string): M3uPlaylist {
	const lines = text.replace(/^﻿/, '').split(/\r?\n/);
	const playlist: M3uPlaylist = { entries: [] };
	let pending: Omit<M3uEntry, 'url'> | null = null;
	for (const raw of lines) {
		const line = raw.trim();
		if (!line) continue;
		if (line.startsWith('#EXTM3U')) {
			const a = attrs(line);
			const epg = (a['url-tvg'] ?? a['x-tvg-url'] ?? '').split(',')[0].trim();
			if (epg) playlist.epgUrl = epg;
		} else if (line.startsWith('#EXTINF')) {
			const { head, name } = splitExtinf(line);
			const a = attrs(head);
			const chno = Number(a['tvg-chno'] ?? a['channel-number'] ?? a['tvg-num']);
			pending = {
				name: name || a['tvg-name'] || 'Untitled',
				tvgId: a['tvg-id'] || undefined,
				logo: a['tvg-logo'] || undefined,
				group: a['group-title'] || undefined,
				chno: Number.isInteger(chno) && chno > 0 ? chno : undefined
			};
		} else if (line.startsWith('#EXTGRP:') && pending && !pending.group) {
			pending.group = line.slice(8).trim();
		} else if (!line.startsWith('#')) {
			if (/^https?:\/\//i.test(line)) playlist.entries.push({ ...(pending ?? { name: line }), url: line });
			pending = null;
		}
	}
	return playlist;
}

// ── XMLTV ────────────────────────────────────────────────────────────────────

/** "20261108193000 +0000" (offset optional, UTC assumed) → epoch seconds. */
export function parseXmltvTime(s: string): number {
	const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(s.trim());
	if (!m) return NaN;
	const [, y, mo, d, h, mi, sec = '00', off] = m;
	let t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec) / 1000;
	if (off) {
		const sign = off[0] === '-' ? -1 : 1;
		t -= sign * (Number(off.slice(1, 3)) * 3600 + Number(off.slice(3, 5)) * 60);
	}
	return t;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s: string): string {
	return s
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
		.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
			if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
			return ENTITIES[e.toLowerCase()] ?? all;
		})
		.trim();
}

function tag(body: string, name: string): string | undefined {
	const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(body);
	return m ? decode(m[1]) || undefined : undefined;
}

/**
 * Programs for the wanted channel ids that overlap [from, until). XMLTV files
 * from big services are tens of MB, so this scans with one regex and skips
 * everything else without building a DOM.
 */
export function parseXmltv(xml: string, wanted: Set<string>, from: number, until: number): Map<string, EpgProgram[]> {
	const out = new Map<string, EpgProgram[]>();
	const re = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
	for (const m of xml.matchAll(re)) {
		const a = attrs(m[1]);
		const channel = decode(a.channel ?? '');
		if (!wanted.has(channel)) continue;
		const start = parseXmltvTime(a.start ?? '');
		const stop = parseXmltvTime(a.stop ?? '');
		if (!(stop > from && start < until) || !(stop > start)) continue;
		const title = tag(m[2], 'title');
		if (!title) continue;
		const p: EpgProgram = { title, start, stop };
		const sub = tag(m[2], 'sub-title');
		const desc = tag(m[2], 'desc');
		if (sub) p.subtitle = sub;
		if (desc) p.desc = desc.slice(0, 300);
		const list = out.get(channel) ?? [];
		list.push(p);
		out.set(channel, list);
	}
	for (const list of out.values()) list.sort((x, y) => x.start - y.start);
	return out;
}

/** Channel ids and display names in an XMLTV file. */
export function xmltvChannels(xml: string): Array<{ id: string; names: string[] }> {
	const out: Array<{ id: string; names: string[] }> = [];
	for (const m of xml.matchAll(/<channel\b([^>]*)>([\s\S]*?)<\/channel>/g)) {
		const id = decode(attrs(m[1]).id ?? '');
		if (!id) continue;
		const names = [...m[2].matchAll(/<display-name\b[^>]*>([\s\S]*?)<\/display-name>/g)].map((n) => decode(n[1])).filter(Boolean);
		out.push({ id, names });
	}
	return out;
}

/** "XITE 90's Throwback (1080p) [Geo-blocked]" → "xite90sthrowback": for matching names across sources. */
export const channelKey = (name: string): string =>
	name
		.toLowerCase()
		.replace(/\[[^\]]*\]|\([^)]*\)/g, '')
		.replace(/[^a-z0-9]/g, '');

// ── airings ──────────────────────────────────────────────────────────────────

/**
 * Airings for a live channel in [from, until), shaped like playlist airings so
 * the guide and banner treat both the same. Gaps in the guide data (or no
 * guide data at all) show as one "LIVE" block.
 */
/** True for a stretch of a live channel that has no guide data. */
export const isLiveGap = (a: Airing): boolean => a.item.id.startsWith('live-gap-');

export function liveAirings(
	url: string,
	channelName: string,
	programs: EpgProgram[] | undefined,
	from: number,
	until: number,
	max = 40
): Airing[] {
	const block = (title: string, start: number, stop: number, i: number, subtitle?: string, gap = false): Airing => {
		// "live-gap-…" marks time with no guide data; the banner shows LIVE for it.
		const item: ScheduledItem = { id: `${gap ? 'live-gap' : 'live'}-${start}`, title, durationSec: stop - start, start: 0, url, sourceKind: 'hls' };
		if (subtitle) item.title = `${title}: ${subtitle}`;
		return { index: i, item, offsetSec: Math.max(0, from - start), startsAt: start, endsAt: stop };
	};
	const out: Airing[] = [];
	let cursor = from;
	for (const p of programs ?? []) {
		if (out.length >= max) break;
		if (p.stop <= cursor) continue;
		if (p.start >= until) break;
		if (p.start > cursor) out.push(block(`${channelName} LIVE`, cursor, p.start, out.length, undefined, true));
		out.push(block(p.title, p.start, p.stop, out.length, p.subtitle));
		cursor = p.stop;
	}
	if (cursor < until && out.length < max) out.push(block(`${channelName} LIVE`, cursor, Number.isFinite(until) ? until : cursor + 3600, out.length, undefined, true));
	return out;
}

// ── HLS playlist pass-through ────────────────────────────────────────────────

const isPlaylistUrl = (u: string): boolean => /\.m3u8?(\?|$)/i.test(new URL(u).pathname + '?');

/**
 * Rewrite an HLS playlist fetched from `base` so the TV loads every nested
 * playlist through the box (`toProxy`) and everything else (segments, keys,
 * init maps) directly, as absolute URLs. Some services send CORS headers on
 * playlists only for their own sites, but allow any origin on segments.
 */
export function rewritePlaylist(text: string, base: string, toProxy: (absoluteUrl: string) => string): string {
	const abs = (ref: string): string => new URL(ref, base).href;
	const route = (ref: string): string => {
		const u = abs(ref);
		return isPlaylistUrl(u) ? toProxy(u) : u;
	};
	return text
		.split(/\r?\n/)
		.map((line) => {
			const t = line.trim();
			if (!t) return line;
			if (!t.startsWith('#')) return route(t);
			// URI="…" inside tags: media/i-frame playlists go through the box; keys and maps go direct.
			return line.replace(/URI="([^"]+)"/g, (_m, ref: string) => {
				const proxied = /^#EXT-X-(MEDIA|I-FRAME-STREAM-INF)\b/.test(t);
				return `URI="${proxied ? route(ref) : abs(ref)}"`;
			});
		})
		.join('\n');
}
