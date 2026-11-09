/**
 * box-api — the read surface for the player. Caches the lineup and every
 * channel's flattened schedule for a few seconds so the TV never waits on a
 * workflow query, serves local media with range requests, and (in production)
 * serves the built player.
 */

import { pairingCode, pairingCodeTtl } from '@box/core/pairing';
import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { hostname } from 'node:os';
import { flatten, playableUrl, type FlatSchedule } from '@box/core/schedule';
import type { Channel, EpgProgram } from '@box/core/types';
import { epgFor } from './epg.js';
import { resolveStream } from '@box/core/plugins';
import type { InstalledPlugin } from '@box/core/types';
import { rewritePlaylist } from '@box/core/live';
import { answerProposal, exportLineup, listChannels, queryLineup, reportPlaybackFailure, unwrapError } from '@box/core/client';

const PORT = Number(process.env.API_PORT ?? 8760);
const MEDIA_ROOT = resolve(process.env.MEDIA_ROOT ?? resolve(import.meta.dirname, '../../../media'));
const PLAYER_BUILD = resolve(import.meta.dirname, '../../../apps/player/build');
const CACHE_MS = 3000;

export interface GuideChannel {
	id: string;
	num: number;
	name: string;
	kind: string;
	card?: string;
	blurb?: string;
	category?: string;
}

export interface GuideData {
	boxName: string;
	serverTime: number;
	channels: GuideChannel[];
	schedules: Record<string, FlatSchedule>;
	/** Live channels: the stream and whatever guide data has arrived. */
	live: Record<string, { url: string | null; logo?: string; programs: EpgProgram[] }>;
	notices: Awaited<ReturnType<typeof queryLineup>>['notices'];
	/** Channels an agent proposed, waiting for OK on the TV. */
	proposals: NonNullable<Awaited<ReturnType<typeof queryLineup>>['proposals']>;
}

let cache: { at: number; data: GuideData } | undefined;
/** Installed plugins, refreshed with the guide (never sent to the player). */
let plugins: InstalledPlugin[] = [];
let inflight: Promise<GuideData> | undefined;

async function load(): Promise<GuideData> {
	const [lineup, channels] = await Promise.all([queryLineup(), listChannels()]);
	plugins = lineup.plugins ?? [];
	return {
		boxName: lineup.boxName,
		serverTime: Date.now() / 1000,
		notices: lineup.notices,
		proposals: lineup.proposals ?? [],
		channels: channels.map((c) => ({ id: c.id, num: c.num, name: c.name, kind: c.kind, card: c.card, blurb: c.blurb, category: c.category })),
		schedules: Object.fromEntries(channels.map((c) => [c.id, flatten(c)])),
		live: Object.fromEntries(channels.filter((c) => c.kind === 'live').map((c) => [c.id, liveEntry(c)]))
	};
}

function liveEntry(c: Channel): GuideData['live'][string] {
	const item = c.items[0];
	return {
		url: item && !item.dead ? playableUrl(item.source) : null,
		logo: c.live?.logo,
		programs: c.live?.epgUrl && c.live.epgId ? epgFor(c.live.epgUrl, c.live.epgId) : []
	};
}

/** Cached guide data. Stale data is served if Temporal is briefly unreachable. */
async function guide(): Promise<GuideData> {
	if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
	inflight ??= load()
		.then((data) => {
			cache = { at: Date.now(), data };
			return data;
		})
		.finally(() => {
			inflight = undefined;
		});
	try {
		return await inflight;
	} catch (err) {
		if (cache) return cache.data;
		throw err;
	}
}

const app = express();

app.get('/api/guide', async (_req, res) => {
	try {
		const data = await guide();
		res.json({ ...data, serverTime: Date.now() / 1000 });
	} catch (err) {
		res.status(503).json({ error: 'We are experiencing technical difficulties. Please stand by.', detail: unwrapError(err) });
	}
});

/** What the setup screen shows: how to reach the box from an agent. */
app.get('/api/box', async (_req, res) => {
	const host = (process.env.BOX_HOSTNAME ?? hostname()).replace(/\.local$/, '');
	const mcpPort = process.env.MCP_PORT ?? 8750;
	let boxName = 'RETRO CABLE';
	try {
		boxName = (await guide()).boxName;
	} catch {
		// Temporal not up yet; the setup screen still works
	}
	res.json({
		boxName,
		version: process.env.BOX_VERSION ?? 'dev',
		lanMcpUrl: `http://${host}.local:${mcpPort}/mcp`,
		publicMcpUrl: process.env.PUBLIC_MCP_URL ?? null,
		token: process.env.MCP_TOKEN ?? null,
		// agent apps sign in with this code (OAuth pairing; services/mcp/src/oauth.ts)
		pairCode: process.env.PUBLIC_MCP_URL && process.env.MCP_TOKEN ? pairingCode(process.env.MCP_TOKEN) : null,
		pairCodeTtl: pairingCodeTtl()
	});
});

/** The channel on screen now, for the front-panel LED (image/led). */
let tuned: { channelId: string; num: number; at: number } | null = null;
app.post('/api/tuned', express.json(), (req, res) => {
	const { channelId, num } = req.body ?? {};
	if (typeof channelId !== 'string' || !Number.isInteger(num)) return void res.status(400).json({ error: 'channelId and num required' });
	tuned = { channelId, num, at: Date.now() / 1000 };
	res.status(204).end();
});
/**
 * Live streams go through the box as playlists only. Some services answer
 * playlists with CORS for their own sites (or send a redirect with no CORS
 * header at all), but allow any origin on video segments and keys. So the box
 * fetches each playlist, rewrites its links (nested playlists back through
 * /api/hls, everything else direct and absolute) and serves it from its own
 * origin. The video itself never passes through the box.
 */
app.get('/api/live/:id', async (req, res) => {
	try {
		const url = (await guide()).live[req.params.id]?.url;
		if (!url) return void res.status(404).json({ error: 'no live stream on that channel' });
		// A plugin's stream recipe can add a step on every tune (for example, a new session).
		let target = url;
		try {
			target = (await resolveStream(plugins, url)).url;
		} catch (err) {
			console.warn(`[box-api] ${(err as Error).message}; playing the stream URL as it is`);
		}
		res.set('Cache-Control', 'no-store').redirect(302, `/api/hls?u=${encodeURIComponent(target)}`);
	} catch (err) {
		res.status(503).json({ error: unwrapError(err) });
	}
});

const HLS_MAX_BYTES = 4 * 1024 * 1024;
app.get('/api/hls', async (req, res) => {
	const u = String(req.query.u ?? '');
	if (!/^https?:\/\//i.test(u)) return void res.status(400).json({ error: 'u must be an http(s) playlist URL' });
	try {
		const r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'RetroCableBox/0.1' } });
		if (!r.ok) return void res.status(502).json({ error: `playlist answered HTTP ${r.status}` });
		const text = await r.text();
		if (text.length > HLS_MAX_BYTES || !text.trimStart().startsWith('#EXTM3U')) {
			return void res.status(502).json({ error: 'not an HLS playlist' });
		}
		res
			.set('Cache-Control', 'no-store')
			.type('application/vnd.apple.mpegurl')
			.send(rewritePlaylist(text, r.url, (abs) => `/api/hls?u=${encodeURIComponent(abs)}`));
	} catch (err) {
		res.status(502).json({ error: `stream did not answer: ${(err as Error).message}` });
	}
});

/**
 * The TV could not play an item. Its channel workflow checks the media and
 * repairs or skips it (a signal; this returns at once). Reports for the same
 * item are rate-limited here and in the workflow.
 */
const lastReport = new Map<string, number>();
app.post('/api/report', express.json(), async (req, res) => {
	const { channelId, itemId } = req.body ?? {};
	if (typeof channelId !== 'string' || typeof itemId !== 'string') return void res.status(400).json({ error: 'channelId and itemId required' });
	const key = `${channelId}/${itemId}`;
	if (Date.now() - (lastReport.get(key) ?? 0) < 60_000) return void res.status(202).json({ ok: true, note: 'already reported' });
	lastReport.set(key, Date.now());
	try {
		await reportPlaybackFailure(channelId, itemId);
		res.status(202).json({ ok: true });
	} catch (err) {
		res.status(502).json({ error: unwrapError(err) });
	}
});

/**
 * The owner's answer to a proposed channel, from the TV remote. Agents cannot
 * reach this: MCP has no tool for it, so a proposal needs a person at the TV.
 */
app.post('/api/proposals/:id', express.json(), async (req, res) => {
	const approve = req.body?.approve;
	if (typeof approve !== 'boolean') return void res.status(400).json({ error: 'approve (true or false) required' });
	try {
		const state = await answerProposal(req.params.id, approve);
		cache = undefined; // the card comes down on the next guide load
		res.json(state);
	} catch (err) {
		res.status(409).json({ error: unwrapError(err) });
	}
});

app.get('/api/tuned', (_req, res) => {
	res.json(tuned ?? { channelId: null, num: null });
});

/** The whole lineup as a portable file (weekly backup, sharing). */
app.get('/api/export', async (_req, res) => {
	try {
		res.set('content-disposition', 'attachment; filename="lineup.json"').json(await exportLineup());
	} catch (err) {
		res.status(503).json({ error: unwrapError(err) });
	}
});

app.get('/api/time', (_req, res) => {
	res.json({ serverTime: Date.now() / 1000 });
});

app.get('/api/healthz', async (_req, res) => {
	try {
		const data = await guide();
		res.json({ ok: true, channels: data.channels.length });
	} catch (err) {
		res.status(503).json({ ok: false, detail: unwrapError(err) });
	}
});

// Local media (the `local` source kind). express.static handles Range requests.
app.use('/media', express.static(MEDIA_ROOT, { fallthrough: false, dotfiles: 'deny' }));

// Production: the built player, with SPA fallback.
// The built player (the Pi, or `pnpm --filter player build` on a laptop).
// Checked per request, so a build made after the API started is served too.
const servePlayer = express.static(PLAYER_BUILD);
app.use((req, res, next) => (existsSync(PLAYER_BUILD) ? servePlayer(req, res, next) : next()));
app.get('*', (_req, res, next) => {
	const index = resolve(PLAYER_BUILD, 'index.html');
	if (!existsSync(index)) return next();
	res.sendFile(index);
});

app.listen(PORT, () => {
	console.log(`[box-api] listening on :${PORT}${existsSync(PLAYER_BUILD) ? ' · serving the player' : ''} · media ${MEDIA_ROOT}`);
});
