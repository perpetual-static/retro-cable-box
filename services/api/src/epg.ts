/**
 * XMLTV guide data for live channels. Fetched in the background and cached per
 * URL for an hour; /api/guide never waits for it. Files from big services are
 * tens of MB (often gzipped), so only the programs for channels on this box,
 * from 3 hours ago to 12 hours ahead, are kept.
 */

import { gunzipSync } from 'node:zlib';
import { parseXmltv } from '@box/core/live';
import type { EpgProgram } from '@box/core/types';

const REFRESH_MS = 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const MAX_BYTES = 200 * 1024 * 1024;

interface Entry {
	ids: Set<string>;
	programs: Map<string, EpgProgram[]>;
	fetchedAt: number;
	failedAt: number;
	loading: boolean;
}

const cache = new Map<string, Entry>();

/** Programs for one channel; starts a background refresh when the data is old or the id is new. */
export function epgFor(url: string, id: string): EpgProgram[] {
	let e = cache.get(url);
	if (!e) {
		e = { ids: new Set(), programs: new Map(), fetchedAt: 0, failedAt: 0, loading: false };
		cache.set(url, e);
	}
	const isNew = !e.ids.has(id);
	e.ids.add(id);
	const now = Date.now();
	const stale = now - e.fetchedAt > REFRESH_MS || (isNew && e.fetchedAt > 0);
	if (stale && !e.loading && now - e.failedAt > RETRY_MS) void refresh(url, e);
	const t = now / 1000;
	return (e.programs.get(id) ?? []).filter((p) => p.stop > t - 3600);
}

async function refresh(url: string, e: Entry): Promise<void> {
	e.loading = true;
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { 'user-agent': 'RetroCableBox/0.1' } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length > MAX_BYTES) throw new Error(`guide data is too big (${Math.round(buf.length / 1e6)} MB)`);
		// fetch undoes Content-Encoding gzip; a .gz file still arrives gzipped.
		const xml = (buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf).toString('utf8');
		const t = Date.now() / 1000;
		e.programs = parseXmltv(xml, e.ids, t - 3 * 3600, t + 12 * 3600);
		e.fetchedAt = Date.now();
		console.log(`[box-api] guide data: ${url} → ${[...e.programs.values()].reduce((n, l) => n + l.length, 0)} programs for ${e.programs.size}/${e.ids.size} channels`);
	} catch (err) {
		e.failedAt = Date.now();
		console.warn(`[box-api] guide data failed: ${url}: ${(err as Error).message}`);
	} finally {
		e.loading = false;
	}
}
