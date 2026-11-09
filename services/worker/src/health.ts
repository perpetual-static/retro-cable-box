/**
 * Health-check activities ("MacGyver"). Checks every item on a channel can
 * still be reached and fixes what it can with what is on hand before giving up.
 */

import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ChannelHealth, Diagnosis } from '@box/core/activities';
import type { Item, Source } from '@box/core/types';
import { archiveMetadata, playableFiles } from '@box/core/archive';
import { airOrder, playableUrl } from '@box/core/schedule';
import { channelHandle, queryChannel, queryLineup } from '@box/core/client';
import { repairItems } from '@box/core/workflows';
import { MEDIA_ROOT } from './config';

type Reach = 'ok' | 'gone' | 'unsure';

const UA = 'retro-cable-box/0.1 (+https://github.com/rossnelson/myvoiceismypassport)';

/** Can a URL be fetched? 404/410 means gone; timeouts and 5xx mean "ask again tomorrow". */
export async function reach(url: string): Promise<Reach> {
	const attempt = async (method: 'HEAD' | 'GET'): Promise<number> => {
		const res = await fetch(url, {
			method,
			redirect: 'follow',
			headers: { 'user-agent': UA, ...(method === 'GET' ? { range: 'bytes=0-0' } : {}) },
			signal: AbortSignal.timeout(20_000)
		});
		await res.body?.cancel();
		return res.status;
	};
	try {
		let status = await attempt('HEAD');
		if (status === 405 || status === 403 || status === 501) status = await attempt('GET');
		if (status < 400) return 'ok';
		if (status === 404 || status === 410) return 'gone';
		return 'unsure';
	} catch {
		return 'unsure';
	}
}

async function reachSource(source: Source): Promise<Reach> {
	if (source.kind === 'local') {
		try {
			await access(resolve(MEDIA_ROOT, source.path));
			return 'ok';
		} catch {
			return 'gone';
		}
	}
	const url = playableUrl(source);
	return url ? reach(url) : 'gone';
}

/** Try to find the same program somewhere else. */
async function macgyver(item: Item): Promise<{ source: Source; durationSec?: number } | null> {
	const s = item.source;
	if (s.kind === 'url' && s.fallbackUrl && (await reach(s.fallbackUrl)) === 'ok') {
		return { source: { kind: 'url', url: s.fallbackUrl } };
	}
	if (s.kind === 'archive') {
		const meta = await archiveMetadata(s.identifier).catch(() => null);
		if (!meta) return null;
		const files = playableFiles(meta).filter((f) => f.file !== s.file);
		// The same program: a file whose length is within 5% of the item's.
		const match =
			files.find((f) => item.durationSec > 0 && Math.abs(f.durationSec - item.durationSec) / item.durationSec < 0.05) ??
			(files.length === 1 ? files[0] : undefined);
		if (!match) return null;
		const source: Source = { kind: 'archive', identifier: s.identifier, file: match.file };
		if ((await reach(playableUrl(source)!)) !== 'ok') return null;
		return { source, durationSec: match.durationSec || undefined };
	}
	return null;
}

/** Run `fn` over `list`, `n` at a time. */
async function pool<T>(list: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(n, list.length) }, async () => {
			while (next < list.length) await fn(list[next++]);
		})
	);
}

export async function listChannelIds(): Promise<string[]> {
	return (await queryLineup()).channelIds;
}

export async function checkChannel(channelId: string): Promise<ChannelHealth> {
	const channel = await queryChannel(channelId);
	const health: ChannelHealth = { channelId, name: channel.name, total: 0, repaired: [], dead: [], revived: [], unsure: 0 };
	if (channel.kind === 'card') return health;

	const replace: { itemId: string; source: Source; durationSec?: number }[] = [];
	const dead: string[] = [];
	const alive: string[] = [];
	const media = channel.items.filter((i) => i.source.kind !== 'hls');
	health.total = media.length;

	await pool(media, 4, async (item) => {
		const r = await reachSource(item.source);
		if (r === 'unsure') {
			health.unsure += 1;
			return;
		}
		if (r === 'ok') {
			if (item.dead) {
				alive.push(item.id);
				health.revived.push(item.title);
			}
			return;
		}
		const fix = await macgyver(item);
		if (fix) {
			replace.push({ itemId: item.id, ...fix });
			health.repaired.push(item.title);
		} else if (!item.dead) {
			dead.push(item.id);
			health.dead.push(item.title);
		}
	});

	if (replace.length || dead.length || alive.length) {
		await (await channelHandle(channelId)).executeUpdate(repairItems, { args: [{ replace, dead, alive }] });
	}
	return health;
}

/** The shows on a channel's regular loop, for a programming block to copy. */
export async function showsForBlock(channelId: string): Promise<Item[]> {
	try {
		return airOrder(await queryChannel(channelId)).filter((i) => i.source.kind !== 'hls');
	} catch {
		return []; // the channel is gone
	}
}

/** One item the TV could not play: reachable, found elsewhere, or gone? */
export async function diagnoseItem(item: Item): Promise<Diagnosis> {
	const r = await reachSource(item.source);
	if (r === 'ok') return { verdict: 'ok' };
	if (r === 'unsure') return { verdict: 'unsure' };
	const fix = await macgyver(item);
	return fix ? { verdict: 'repaired', ...fix } : { verdict: 'dead' };
}

