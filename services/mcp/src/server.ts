/**
 * box-mcp — the curation surface. An agent (any MCP client) reads the lineup and builds channels.
 *
 * Reads are Temporal queries; writes are Durable Updates (validated in the
 * workflow, so a bad edit comes back with the reason). Adding media starts an
 * ingest workflow that resolves archive.org items / URLs into timed items.
 * Transport: stateless Streamable HTTP at POST /mcp.
 */

import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { BoxOAuthProvider } from './oauth.js';
import type { Channel, LineupFile, Notice, PluginManifest, SourceRequest } from '@box/core/types';
import { checkInstalled, MANIFEST_FILE, resolveStream } from '@box/core/plugins';
import { upcoming } from '@box/core/blocks';
import { airings, anchorForItemAt, flatten, whatsOn } from '@box/core/schedule';
import { archiveMetadata, playableFiles, searchArchive } from '@box/core/archive';
import { channelKey, parseM3u, xmltvChannels, type M3uEntry, type M3uPlaylist } from '@box/core/live';
import { gunzipSync } from 'node:zlib';
import {
	channelFromFile,
	channelHandle,
	createChannel,
	exportLineup,
	getClient,
	importLineup,
	installPluginFrom,
	proposeChannel,
	proposalStatus,
	installPluginManifest,
	uninstallPlugin,
	updatePlugins,
	ingest,
	lineupHandle,
	listChannels,
	queryChannel,
	queryLineup,
	removeChannel,
	runHealthcheck,
	temporalConfig,
	unwrapError
} from '@box/core/client';
import {
	dismissNotice,
	moveItem,
	postNotice,
	removeItem,
	setAnchor,
	setBubbles,
	setLive,
	removeBlock,
	setBlock,
	setRules,
	updateChannel
} from '@box/core/workflows';

const VERSION = '0.1.0';
const TZ = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// ── Auth ─────────────────────────────────────────────────────────────────────
// MCP_TOKEN: a fixed bearer token (agents on the LAN; channel 0 shows it).
// PUBLIC_MCP_URL: set when the box is on the internet (Tailscale Funnel). Then
// agent apps can also sign in with OAuth, using the pairing code on channel 0.
const TOKEN = process.env.MCP_TOKEN;
const PUBLIC_MCP_URL = process.env.PUBLIC_MCP_URL ? new URL(process.env.PUBLIC_MCP_URL) : null;
const BOX_DATA = process.env.BOX_DATA ?? join(fileURLToPath(new URL('../../..', import.meta.url)), '.temporal');

if (PUBLIC_MCP_URL && !TOKEN) console.warn('[box-mcp] PUBLIC_MCP_URL is set but MCP_TOKEN is not: OAuth pairing is off, and the box is open to anyone.');

const oauth =
	PUBLIC_MCP_URL && TOKEN
		? new BoxOAuthProvider(join(BOX_DATA, 'oauth.json'), TOKEN, (name) => {
				const notice: Notice = {
					id: `n-pair-${Date.now().toString(36)}`,
					headline: 'NEW CONNECTION',
					body: `${name} paired with this box and can now program it. Ask your agent to forget_connection to undo it.`,
					kind: 'info',
					createdAt: Math.floor(Date.now() / 1000)
				};
				void lineupHandle()
					.then((h) => h.executeUpdate(postNotice, { args: [{ notice }] }))
					.catch((err) => console.warn('[box-mcp] pairing notice failed:', unwrapError(err)));
			})
		: null;

// ── result helpers ───────────────────────────────────────────────────────────

const text = (value: unknown): CallToolResult => ({
	content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
});
const rejected = (message: string): CallToolResult => ({
	content: [{ type: 'text', text: `Rejected: ${message}` }],
	isError: true
});

async function attempt(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
	try {
		return await fn();
	} catch (err) {
		return rejected(unwrapError(err));
	}
}

const clock = (sec: number): string =>
	new Date(sec * 1000).toLocaleString('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' });
/** With the date, for things days or weeks ahead (block airings). */
const dateClock = (sec: number): string =>
	new Date(sec * 1000).toLocaleString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const mins = (sec: number): string => `${Math.round(sec / 60)} min`;
const hours = (sec: number): string => `${(sec / 3600).toFixed(1)} h`;

/** What an editing agent needs to target edits on a channel. */
function outline(c: Channel) {
	const flat = flatten(c);
	const now = whatsOn(flat, Date.now() / 1000);
	return {
		id: c.id,
		num: c.num,
		name: c.name,
		kind: c.kind,
		card: c.card,
		blurb: c.blurb,
		category: c.category,
		rules: c.rules,
		blocks: c.blocks?.length
			? c.blocks.map((b) => ({
					...b,
					next: upcoming([b], Date.now() / 1000, 14)
						.slice(0, 3)
						.map((o) => `${dateClock(o.startsAt)} – ${clock(o.endsAt)}`)
				}))
			: undefined,
		blockOnAir: (c.windows ?? []).find((w) => w.startsAt <= Date.now() / 1000 && Date.now() / 1000 < w.endsAt)?.name,
		loop: hours(flat.totalSec),
		onNow: now ? `${now.item.title} (${mins(now.offsetSec)} in, ends ${clock(now.endsAt)})` : null,
		items: c.items.map((i, index) => ({
			index,
			itemId: i.id,
			title: i.title,
			length: mins(i.durationSec),
			year: i.year,
			bubbles: i.bubbles?.length ?? 0,
			airs: i.durationSec > 0 ? undefined : 'no — unresolved'
		}))
	};
}

async function channelUpdate(id: string, action: string, run: (h: Awaited<ReturnType<typeof channelHandle>>) => Promise<Channel>) {
	return attempt(async () => {
		const c = await run(await channelHandle(id));
		return text(`${action}\n\n${JSON.stringify(outline(c), null, 2)}`);
	});
}

// ── schemas ──────────────────────────────────────────────────────────────────

const channelId = z.string().describe('Channel id (slug), e.g. "toon-lab". See list_channels.');

const sourceSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('archive'),
		identifier: z.string().describe('archive.org identifier, e.g. "DuckandC1951"'),
		file: z
			.string()
			.optional()
			.describe('One file in the item. Omit to add every video in the item (one item per episode).')
	}),
	z.object({
		kind: z.literal('url'),
		url: z.string().url().regex(/^https?:\/\//, 'http(s) only').describe('Direct MP4/WebM/MP3 URL'),
		fallbackUrl: z.string().url().regex(/^https?:\/\//, 'http(s) only').optional().describe('Second copy the health check switches to if the first URL dies')
	}),
	z.object({ kind: z.literal('local'), path: z.string().describe('Path under the box media folder') }),
	z.object({ kind: z.literal('hls'), url: z.string().url() })
]);

const sourceRequestSchema = z.object({
	source: sourceSchema,
	title: z.string().optional().describe('Override the title (single-file sources only)'),
	year: z.number().int().optional(),
	tags: z.array(z.string()).optional(),
	durationSec: z.number().positive().optional().describe('Skip probing and use this length')
});

const bubbleSchema = z.object({
	atSec: z.number().min(0).describe('Seconds into the item'),
	text: z.string().min(1).max(90).describe('One fact, ≤ 90 chars, in the voice of a 90s pop-up trivia bubble'),
	durationSec: z.number().positive().max(20).optional()
});

const cardKind = z.enum(['clock', 'standby', 'notices']);

// ── server ───────────────────────────────────────────────────────────────────


// ── live playlists ───────────────────────────────────────────────────────────

const M3U_MAX_BYTES = 30 * 1024 * 1024;

async function fetchM3u(url: string): Promise<M3uPlaylist> {
	const res = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'RetroCableBox/0.1' } });
	if (!res.ok) throw new Error(`playlist answered HTTP ${res.status}`);
	const body = await res.text();
	if (body.length > M3U_MAX_BYTES) throw new Error('playlist is too big');
	const playlist = parseM3u(body);
	if (playlist.entries.length === 0) throw new Error('no channels in that playlist (is it an M3U file?)');
	return playlist;
}

const slugify = (s: string): string =>
	s
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40) || 'live';

function findEntry(entries: M3uEntry[], match: string): M3uEntry | undefined {
	const m = match.trim().toLowerCase();
	return (
		entries.find((e) => e.tvgId?.toLowerCase() === m) ??
		entries.find((e) => e.name.toLowerCase() === m) ??
		entries.find((e) => e.url === match.trim())
	);
}

const XMLTV_MAX_BYTES = 200 * 1024 * 1024;
async function fetchXmltv(url: string): Promise<string> {
	const res = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { 'user-agent': 'RetroCableBox/0.1' } });
	if (!res.ok) throw new Error(`guide data answered HTTP ${res.status}`);
	const buf = Buffer.from(await res.arrayBuffer());
	if (buf.length > XMLTV_MAX_BYTES) throw new Error('guide data is too big');
	return (buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf).toString('utf8');
}

const nameMatch = (s: string, q: string): boolean => s.toLowerCase().includes(q.toLowerCase());

function buildServer(): McpServer {
	const server = new McpServer(
		{ name: 'retro-cable-box', version: VERSION },
		{
			instructions:
				'You are the programming director of a retro cable box. Channels loop their items on a shared clock, so viewers tune in mid-show. ' +
				'Use search_archive and inspect_archive_item to find media, then create_channel / add_items. ' +
				'The owner decides what plays on their box: their own files, servers on their network, or sources they name. ' +
				'When you suggest media yourself, prefer public-domain sources. ' +
				'Channel names are UPPERCASE, ≤ 16 chars looks best on the guide.'
		}
	);

	server.registerTool(
		'list_channels',
		{ title: 'List channels', description: 'The lineup: number, name, kind, item count, loop length and what is on now.' },
		async () =>
			attempt(async () => {
				const channels = await listChannels();
				const now = Date.now() / 1000;
				return text(
					channels.map((c) => {
						const flat = flatten(c);
						const on = whatsOn(flat, now);
						return {
							num: c.num,
							id: c.id,
							name: c.name,
							kind: c.kind === 'card' ? `card:${c.card}` : c.kind,
							items: c.items.length,
							loop: hours(flat.totalSec),
							onNow: on?.item.title ?? null
						};
					})
				);
			})
	);

	server.registerTool(
		'get_channel',
		{ title: 'Get channel', description: 'One channel with every item (itemId, title, length) and what is on now.', inputSchema: { id: channelId } },
		async ({ id }) => attempt(async () => text(outline(await queryChannel(id))))
	);

	server.registerTool(
		'whats_on',
		{
			title: "What's on",
			description: 'Now and next across the lineup, or for one channel. Pass "at" (ISO date-time) to ask about another time, e.g. "what is on 7 tonight".',
			inputSchema: {
				id: channelId.optional(),
				at: z.string().optional().describe('ISO 8601 date-time; default now'),
				next: z.number().int().min(0).max(10).default(2).describe('How many upcoming items to list per channel')
			}
		},
		async ({ id, at, next }) =>
			attempt(async () => {
				const t = at ? Date.parse(at) / 1000 : Date.now() / 1000;
				if (!Number.isFinite(t)) return rejected(`could not read the time "${at}"`);
				const channels = id ? [await queryChannel(id)] : await listChannels();
				return text({
					at: clock(t),
					timeZone: TZ,
					channels: channels.map((c) => {
						if (c.kind === 'card') return { num: c.num, name: c.name, on: `${c.card} card` };
						const list = airings(flatten(c), t, Infinity, next + 1);
						return {
							num: c.num,
							name: c.name,
							on: list[0] ? `${list[0].item.title} (since ${clock(list[0].startsAt)})` : 'nothing to air',
							next: list.slice(1).map((a) => `${clock(a.startsAt)} ${a.item.title}`)
						};
					})
				});
			})
	);

	server.registerTool(
		'preview_schedule',
		{
			title: 'Preview schedule',
			description: 'The grid for one channel over the next N hours (default 6), with start times in the box time zone.',
			inputSchema: { id: channelId, hours: z.number().min(0.5).max(48).default(6), from: z.string().optional().describe('ISO date-time; default now') }
		},
		async ({ id, hours: h, from }) =>
			attempt(async () => {
				const c = await queryChannel(id);
				const t = from ? Date.parse(from) / 1000 : Date.now() / 1000;
				const list = airings(flatten(c), t, t + h * 3600);
				return text({
					channel: `${c.num} ${c.name}`,
					timeZone: TZ,
					grid: list.map((a) => `${clock(a.startsAt)}  ${a.item.title}  (${mins(a.item.durationSec)})  [${a.item.id}]`)
				});
			})
	);

	server.registerTool(
		'search_archive',
		{
			title: 'Search archive.org',
			description:
				'Search archive.org for videos. Results are sorted by downloads and show the license. Then call inspect_archive_item to see the files and lengths. ' +
				'Query syntax is archive.org advanced search, e.g. "betty boop", "collection:prelinger AND safety", "subject:cartoons AND year:[1930 TO 1940]".',
			inputSchema: {
				query: z.string().min(1),
				rows: z.number().int().min(1).max(50).default(15),
				publicDomainOnly: z.boolean().default(true).describe('Limit to items marked public domain (plus Prelinger, classic cartoons and NASA)'),
				mediatype: z.enum(['movies', 'audio']).default('movies')
			}
		},
		async ({ query, rows, publicDomainOnly, mediatype }) =>
			attempt(async () => {
				const hits = await searchArchive(query, { rows, publicDomainOnly, mediatype });
				if (hits.length === 0) return text('The truth is out there. Try another search.');
				return text(hits);
			})
	);

	server.registerTool(
		'inspect_archive_item',
		{
			title: 'Inspect archive.org item',
			description: 'The playable files in one archive.org item (one per program), with lengths and the license. Use before add_items to pick files.',
			inputSchema: { identifier: z.string() }
		},
		async ({ identifier }) =>
			attempt(async () => {
				const meta = await archiveMetadata(identifier);
				if (!meta) return rejected(`no archive.org item "${identifier}"`);
				return text({
					identifier,
					title: meta.title,
					year: meta.year,
					license: meta.licenseurl ?? 'none stated — check before airing',
					collection: meta.collection,
					files: playableFiles(meta).map((f) => ({ file: f.file, title: f.title, length: mins(f.durationSec), format: f.format }))
				});
			})
	);

	server.registerTool(
		'create_channel',
		{
			title: 'Create channel',
			description: 'Start a new channel. Optionally give sources to fill it in the same call (they are ingested and the result is reported).',
			inputSchema: {
				id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).describe('Slug, e.g. "saturday-toons"'),
				num: z.number().int().min(1).max(999).describe('Guide number; must be free'),
				name: z.string().min(1).max(24).describe('UPPERCASE guide name, ≤ 16 chars looks best'),
				kind: z.enum(['playlist', 'card']).default('playlist'),
				card: cardKind.optional().describe('For card channels: clock, standby or notices'),
				blurb: z.string().max(140).optional(),
				category: z.string().max(24).optional(),
				shuffleSeed: z.number().int().optional().describe('Air items in a seeded shuffle'),
				sources: z.array(sourceRequestSchema).optional()
			}
		},
		async (input) =>
			attempt(async () => {
				const channel = channelFromFile({
					id: input.id,
					num: input.num,
					name: input.name,
					kind: input.kind,
					card: input.card,
					blurb: input.blurb,
					category: input.category,
					rules: input.shuffleSeed === undefined ? undefined : { shuffleSeed: input.shuffleSeed }
				});
				await createChannel(channel);
				let report = '';
				if (input.sources?.length) {
					const r = await ingest(channel.id, input.sources as SourceRequest[]);
					report = `\nIngest: added ${r!.added.length}, failed ${r!.failed.length}${r!.failed.length ? ` → ${JSON.stringify(r!.failed)}` : ''}`;
				}
				return text(`Created channel ${channel.num} ${channel.name}.${report}\n\n${JSON.stringify(outline(await queryChannel(channel.id)), null, 2)}`);
			})
	);

	server.registerTool(
		'set_block',
		{
			title: 'Set programming block',
			description:
				'At set times, another channel\'s shows air on this channel: "Saturday-morning cartoons on 3 from 7 to 11 every Saturday", ' +
				'"a Halloween takeover of channel 2 on October 31". Give days (0 = Sunday … 6 = Saturday) for a weekly block, or one date. ' +
				'The channel workflow arms each airing 6 hours ahead (it shows on the guide then), copies and shuffles the shows at that moment, ' +
				'announces the block when it starts, and returns to regular programming (in progress) when it ends. It survives restarts: ' +
				'a box that was off catches up. Setting a block with an existing id replaces it.',
			inputSchema: {
				id: channelId,
				block: z.object({
					id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).describe('Block slug, e.g. "saturday-toons"'),
					name: z.string().min(1).max(24).describe('UPPERCASE name for the guide and the start notice'),
					fromChannel: z.string().describe('Channel id whose shows air in the block'),
					days: z.array(z.number().int().min(0).max(6)).optional(),
					date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD for a one-off block'),
					start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).describe('Local start time, HH:MM 24-hour'),
					durationMin: z.number().int().min(15).max(1440),
					tz: z.string().optional().describe(`IANA time zone; default the box's (${TZ})`),
					shuffle: z.boolean().optional().describe('Shuffle the shows for each airing (default true)')
				})
			}
		},
		async ({ id, block }) =>
			attempt(async () => {
				const c = await (await channelHandle(id)).executeUpdate(setBlock, { args: [{ block: { ...block, tz: block.tz ?? TZ } }] });
				return text(outline(c));
			})
	);

	server.registerTool(
		'remove_block',
		{ title: 'Remove programming block', description: 'Remove a block. An airing in progress stops now and regular programming resumes.', inputSchema: { id: channelId, blockId: z.string() } },
		async ({ id, blockId }) =>
			attempt(async () => text(outline(await (await channelHandle(id)).executeUpdate(removeBlock, { args: [{ blockId }] }))))
	);

	server.registerTool(
		'propose_channel',
		{
			title: 'Propose channel',
			description:
				'Propose a new channel for the owner to approve on the TV. The box resolves the sources, then shows a card on the TV: ' +
				'OK on the remote adds the channel, BACK declines it. The proposal waits up to `expiresInHours` (default 72). ' +
				'You cannot approve it yourself; use proposal_status to see the answer. Use this when the owner wants to approve channels, ' +
				'or when you are suggesting something they did not ask for; use create_channel when they asked for the channel directly.',
			inputSchema: {
				id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).describe('Slug, e.g. "saturday-toons"'),
				num: z.number().int().min(1).max(999).describe('Guide number; must be free'),
				name: z.string().min(1).max(24).describe('UPPERCASE guide name, ≤ 16 chars looks best'),
				blurb: z.string().max(140).optional(),
				category: z.string().max(24).optional(),
				shuffleSeed: z.number().int().optional(),
				sources: z.array(sourceRequestSchema).min(1),
				expiresInHours: z.number().min(0.05).max(24 * 30).default(72),
				from: z.string().max(40).optional().describe('Your name as the owner should see it, e.g. "Claude"')
			}
		},
		async (input) =>
			attempt(async () => {
				const channel = channelFromFile({
					id: input.id,
					num: input.num,
					name: input.name,
					blurb: input.blurb,
					category: input.category,
					rules: input.shuffleSeed === undefined ? undefined : { shuffleSeed: input.shuffleSeed }
				});
				await proposeChannel(channel, input.sources as SourceRequest[], { expiresInSec: Math.round(input.expiresInHours * 3600), from: input.from });
				return text(
					`Proposed ${input.num} ${input.name}. The box is resolving the shows; then a card appears on the TV. ` +
						`OK on the remote adds it, BACK declines. Check with proposal_status("${input.id}").`
				);
			})
	);

	server.registerTool(
		'proposal_status',
		{
			title: 'Proposal status',
			description: 'Where a proposed channel stands: resolving, waiting (on the TV), approved, declined, expired or failed.',
			inputSchema: { id: z.string() }
		},
		async ({ id }) => attempt(async () => text(await proposalStatus(id)))
	);

	server.registerTool(
		'update_channel',
		{
			title: 'Update channel',
			description: 'Change a channel’s number, name, blurb, category or card kind. Renumbering fails if the number is taken.',
			inputSchema: {
				id: channelId,
				patch: z.object({
					num: z.number().int().min(1).max(999).optional(),
					name: z.string().min(1).max(24).optional(),
					blurb: z.string().max(140).optional(),
					category: z.string().max(24).optional(),
					card: cardKind.optional()
				})
			}
		},
		async ({ id, patch }) =>
			attempt(async () => {
				if (patch.num !== undefined) {
					const clash = (await listChannels()).find((c) => c.num === patch.num && c.id !== id);
					if (clash) return rejected(`channel ${patch.num} is taken by ${clash.name} (${clash.id})`);
				}
				return channelUpdate(id, `Updated ${id}.`, (h) => h.executeUpdate(updateChannel, { args: [{ patch }] }));
			})
	);

	server.registerTool(
		'remove_channel',
		{ title: 'Remove channel', description: 'Delete a channel from the lineup. Requires confirm=true.', inputSchema: { id: channelId, confirm: z.boolean() } },
		async ({ id, confirm }) =>
			attempt(async () => {
				if (!confirm) return rejected('Refusing to remove: pass confirm=true.');
				await removeChannel(id);
				return text(`Removed ${id}.`);
			})
	);

	server.registerTool(
		'add_items',
		{
			title: 'Add items',
			description:
				'Add media to a channel. Each source is resolved (archive.org metadata or ffprobe) to get its length, then appended. ' +
				'An archive item with no file given adds every program in it. Waits for the result.',
			inputSchema: { id: channelId, sources: z.array(sourceRequestSchema).min(1).max(100) }
		},
		async ({ id, sources }) =>
			attempt(async () => {
				await queryChannel(id); // fail fast on a bad id
				const r = await ingest(id, sources as SourceRequest[]);
				const c = await queryChannel(id);
				return text({
					added: r!.added.map((a) => `${a.title} (${mins(a.durationSec)}) [${a.id}]`),
					failed: r!.failed,
					channel: outline(c)
				});
			})
	);

	server.registerTool(
		'remove_item',
		{ title: 'Remove item', description: 'Remove one item from a channel by itemId.', inputSchema: { id: channelId, itemId: z.string() } },
		async ({ id, itemId }) => channelUpdate(id, `Removed ${itemId}.`, (h) => h.executeUpdate(removeItem, { args: [{ itemId }] }))
	);

	server.registerTool(
		'move_item',
		{ title: 'Move item', description: 'Move an item to a new position (0-based) in the channel’s list.', inputSchema: { id: channelId, itemId: z.string(), to: z.number().int().min(0) } },
		async ({ id, itemId, to }) => channelUpdate(id, `Moved ${itemId} to ${to}.`, (h) => h.executeUpdate(moveItem, { args: [{ itemId, to }] }))
	);

	server.registerTool(
		'set_anchor',
		{
			title: 'Set air time',
			description: 'Shift the channel’s clock so one item starts at a given time, e.g. "make the pilot air at 8pm Saturday". Everything else follows in order.',
			inputSchema: { id: channelId, itemId: z.string(), at: z.string().describe('ISO 8601 date-time with offset, e.g. "2026-11-14T20:00:00-05:00"') }
		},
		async ({ id, itemId, at }) =>
			attempt(async () => {
				const t = Date.parse(at) / 1000;
				if (!Number.isFinite(t)) return rejected(`could not read the time "${at}"`);
				const c = await queryChannel(id);
				const anchor = anchorForItemAt(flatten(c), itemId, t);
				if (anchor === null) return rejected(`item ${itemId} is not on the air schedule of ${id}`);
				return channelUpdate(id, `${itemId} now starts at ${clock(t)}.`, (h) => h.executeUpdate(setAnchor, { args: [{ anchorEpoch: anchor }] }));
			})
	);

	server.registerTool(
		'set_rules',
		{
			title: 'Set rules',
			description: 'Shuffle a channel with a seed (same seed, same order), or pass shuffleSeed=null to air in list order. The current item keeps playing.',
			inputSchema: { id: channelId, shuffleSeed: z.number().int().nullable() }
		},
		async ({ id, shuffleSeed }) =>
			channelUpdate(id, shuffleSeed === null ? 'Shuffle off.' : `Shuffle seed ${shuffleSeed}.`, (h) =>
				h.executeUpdate(setRules, { args: [{ rules: shuffleSeed === null ? {} : { shuffleSeed } }] })
			)
	);

	server.registerTool(
		'add_bubbles',
		{
			title: 'Add pop-up bubbles',
			description:
				'Write pop-up trivia bubbles for an item: short facts that pop up over the video at given seconds. ' +
				'Base them on what you know about the film (year, makers, history). One fact each, ≤ 90 chars, spaced ≥ 30 s apart. ' +
				'Merges with existing bubbles unless replace=true.',
			inputSchema: { id: channelId, itemId: z.string(), bubbles: z.array(bubbleSchema).min(1).max(40), replace: z.boolean().default(false) }
		},
		async ({ id, itemId, bubbles, replace }) =>
			attempt(async () => {
				const c = await queryChannel(id);
				const existing = replace ? [] : (c.items.find((i) => i.id === itemId)?.bubbles ?? []);
				return channelUpdate(id, `Bubbles set on ${itemId}.`, (h) =>
					h.executeUpdate(setBubbles, { args: [{ itemId, bubbles: [...existing, ...bubbles] }] })
				);
			})
	);

	server.registerTool(
		'export_lineup',
		{ title: 'Export lineup', description: 'The whole lineup as a portable JSON file (share it, back it up, import it on another box).' },
		async () => attempt(async () => text(await exportLineup()))
	);

	server.registerTool(
		'import_lineup',
		{
			title: 'Import lineup',
			description: 'Add the channels from a lineup file (by URL or inline JSON). Channels whose id or number is taken are skipped and reported.',
			inputSchema: { url: z.string().url().optional(), lineup: z.any().optional().describe('A lineup file object (version 1)') }
		},
		async ({ url, lineup }) =>
			attempt(async () => {
				let file = lineup as LineupFile | undefined;
				if (url) {
					const res = await fetch(url);
					if (!res.ok) return rejected(`could not fetch ${url}: ${res.status}`);
					file = (await res.json()) as LineupFile;
				}
				if (!file) return rejected('pass url or lineup');
				return text(await importLineup(file));
			})
	);

	server.registerTool(
		'post_notice',
		{
			title: 'Post notice',
			description: 'Put a message on the bulletin board channel and the guide banner.',
			inputSchema: { headline: z.string().min(1).max(60), body: z.string().max(400).default(''), kind: z.enum(['info', 'warning', 'update']).default('info') }
		},
		async ({ headline, body, kind }) =>
			attempt(async () => {
				const notice: Notice = { id: `n-${Date.now().toString(36)}`, headline, body, kind, createdAt: Math.floor(Date.now() / 1000) };
				await (await lineupHandle()).executeUpdate(postNotice, { args: [{ notice }] });
				return text(`Posted notice ${notice.id}.`);
			})
	);

	// ── plugins ──────────────────────────────────────────────────────────────
	const recipeSchema = z.object({
		match: z.string().describe('Regular expression (case-insensitive) for the stream URLs this recipe handles. Must not match every URL.'),
		session: z
			.object({ url: z.string().describe('GET request template, made on every tune'), headers: z.record(z.string()).optional() })
			.optional()
			.describe('One request on every tune; its JSON response fills {r.path} fields'),
		playlist: z.string().describe('Template for the playlist URL to play. Fields: {1}…{9} match groups, {url}, {device}, {uuid}, {r.path.to.field}')
	});

	server.registerTool(
		'install_plugin',
		{
			title: 'Install plugin',
			description:
				`Install a plugin: what the box knows about an outside service. Give \`repo\`: a GitHub repo that publishes ${MANIFEST_FILE} in its releases ` +
				'("owner/repo" installs the latest release and updates nightly when the repo publishes a new release; "owner/repo@tag" pins one release), ' +
				'or a URL to a manifest file. Or give `manifest` to install one you write in place (it never updates on its own). ' +
				'A manifest is data, never code: {"plugin":1,"id","name","description","version","streams":[recipe…],"channels":[lineup-file channels]}. ' +
				'A stream recipe adds a step before matching streams play, for example a new session on every tune. ' +
				'Installing creates the plugin\'s channels (a taken id or number is skipped); updates add only channels the plugin never offered before. ' +
				'Install only from sources the owner trusts and names. Plugins from GitHub repos may not call the owner\'s own network; a manifest you write in place or one from a URL the owner gives may.',
			inputSchema: {
				repo: z.string().optional(),
				manifest: z
					.object({
						plugin: z.literal(1),
						id: z.string(),
						name: z.string(),
						description: z.string().optional(),
						version: z.string().optional(),
						streams: z.array(recipeSchema).optional(),
						channels: z.array(z.record(z.unknown())).optional()
					})
					.optional()
			}
		},
		async ({ repo, manifest }) =>
			attempt(async () => {
				if (!!repo === !!manifest) throw new Error('give exactly one of repo or manifest');
				const r = repo ? await installPluginFrom(repo) : await installPluginManifest(manifest as unknown as PluginManifest);
				return text({
					[r.action]: r.plugin.id,
					name: r.plugin.name,
					release: r.plugin.release ?? null,
					streamRecipes: r.plugin.streams.length,
					channels: r.channels
				});
			})
	);

	server.registerTool(
		'list_plugins',
		{ title: 'List plugins', description: 'The installed plugins: where each came from, its release, its stream recipes and the channels it offered.' },
		async () => attempt(async () => text((await queryLineup()).plugins ?? []))
	);

	server.registerTool(
		'remove_plugin',
		{
			title: 'Remove plugin',
			description: 'Uninstall a plugin. Its stream recipes stop at once. Its channels stay; remove them with remove_channel if the owner wants.',
			inputSchema: { pluginId: z.string() }
		},
		async ({ pluginId }) =>
			attempt(async () => {
				await uninstallPlugin(pluginId);
				return text(`Removed plugin ${pluginId}.`);
			})
	);

	server.registerTool(
		'update_plugins',
		{
			title: 'Update plugins',
			description: 'Look now for new GitHub releases of the installed plugins and install them (the box also does this every night).'
		},
		async () => attempt(async () => text(await updatePlugins()))
	);

	server.registerTool(
		'test_stream',
		{
			title: 'Test stream',
			description:
				'Show what the box will play for a stream URL: which plugin recipe matches and the playlist URL it makes. ' +
				'Give `recipe` to test one before you install it. Makes the session request for real.',
			inputSchema: { url: z.string().url(), recipe: recipeSchema.optional() }
		},
		async ({ url, recipe }) =>
			attempt(async () => {
				const plugins = recipe
					? [{ id: 'test', name: 'test recipe', streams: [recipe], offeredChannels: [], installedAt: 0, updatedAt: 0 }]
					: ((await queryLineup()).plugins ?? []);
				if (recipe) checkInstalled(plugins[0]);
				const r = await resolveStream(plugins, url);
				let playlist = 'not checked';
				try {
					const res = await fetch(r.url, { signal: AbortSignal.timeout(10_000) });
					const body = await res.text();
					playlist = res.ok && body.trimStart().startsWith('#EXTM3U') ? 'answers with an HLS playlist' : `answered HTTP ${res.status}, not an HLS playlist`;
				} catch (err) {
					playlist = `did not answer: ${(err as Error).message}`;
				}
				return text({ plugin: r.plugin, plays: r.url, playlist });
			})
	);

	server.registerTool(
		'dismiss_notice',
		{ title: 'Dismiss notice', description: 'Remove a notice by id (see box_status).', inputSchema: { noticeId: z.string() } },
		async ({ noticeId }) =>
			attempt(async () => {
				await (await lineupHandle()).executeUpdate(dismissNotice, { args: [{ id: noticeId }] });
				return text(`Dismissed ${noticeId}.`);
			})
	);

	server.registerTool(
		'run_healthcheck',
		{
			title: 'Run health check',
			description:
				'Check that every item on every channel can still be reached (it also runs nightly at 3:30 am). ' +
				'Broken links are repaired from the same archive.org item or a fallback URL when possible; the rest stop airing. Takes a minute or two.'
		},
		async () =>
			attempt(async () => {
				const r = await runHealthcheck();
				return text({
					repaired: r.repaired,
					dead: r.dead,
					revived: r.revived,
					notice: r.notice ?? 'All clear. Nothing to fix.',
					channels: r.channels
						.filter((c) => c.total > 0)
						.map((c) => ({ channel: c.name, items: c.total, repaired: c.repaired, dead: c.dead, revived: c.revived, unsure: c.unsure }))
				});
			})
	);

	server.registerTool(
		'box_status',
		{ title: 'Box status', description: 'Version, uptime, Temporal connection, channel count and notices.' },
		async () =>
			attempt(async () => {
				await getClient();
				const lineup = await queryLineup();
				return text({
					box: lineup.boxName,
					version: VERSION,
					uptime: hours(process.uptime()),
					timeZone: TZ,
					temporal: temporalConfig,
					channels: lineup.channelIds.length,
					notices: lineup.notices,
					publicUrl: PUBLIC_MCP_URL?.href ?? null,
					connections: oauth?.paired().map((c) => ({ ...c, pairedAt: new Date(c.pairedAt * 1000).toISOString() })) ?? []
				});
			})
	);

	server.registerTool(
		'inspect_m3u',
		{
			title: 'Inspect M3U playlist',
			description:
				'Read an M3U / IPTV playlist URL the user gives you (free live TV services through playlist tools, iptv-org, HDHomeRun, ErsatzTV, Tunarr). ' +
				'Lists channels with their group, tvg-id and suggested number, plus the guide-data (XMLTV) URL from the header. Filter with search or group. ' +
				'Then use add_live_channels to put the ones the user wants on the box.',
			inputSchema: {
				url: z.string().url(),
				search: z.string().optional().describe('Case-insensitive text to find in channel names'),
				group: z.string().optional().describe('Only this group-title (substring match)'),
				limit: z.number().int().min(1).max(300).default(60)
			}
		},
		async ({ url, search, group, limit }) =>
			attempt(async () => {
				const p = await fetchM3u(url);
				const groups = new Map<string, number>();
				for (const e of p.entries) groups.set(e.group ?? '(none)', (groups.get(e.group ?? '(none)') ?? 0) + 1);
				const hits = p.entries.filter((e) => (!search || nameMatch(e.name, search)) && (!group || nameMatch(e.group ?? '', group)));
				return text({
					total: p.entries.length,
					epgUrl: p.epgUrl ?? null,
					groups: Object.fromEntries([...groups].sort((a, b) => b[1] - a[1]).slice(0, 40)),
					matched: hits.length,
					channels: hits.slice(0, limit).map((e) => ({ name: e.name, group: e.group, tvgId: e.tvgId, chno: e.chno })),
					more: hits.length > limit ? `${hits.length - limit} more; narrow with search or group` : undefined
				});
			})
	);

	server.registerTool(
		'add_live_channels',
		{
			title: 'Add live channels',
			description:
				'Put live channels from an M3U playlist on the box. Each pick matches a playlist channel by tvg-id or exact name (see inspect_m3u) and gives it a free guide number. ' +
				'Live channels play the stream as it is (no shared clock, no bubbles). The guide shows program titles when the playlist has XMLTV guide data.',
			inputSchema: {
				playlistUrl: z.string().url(),
				epgUrl: z.string().url().optional().describe('XMLTV guide data; defaults to the one in the playlist header'),
				picks: z
					.array(
						z.object({
							match: z.string().describe('tvg-id or exact channel name from inspect_m3u'),
							num: z.number().int().min(1).max(999),
							name: z.string().min(1).max(24).optional().describe('UPPERCASE guide name; defaults to the playlist name'),
							blurb: z.string().max(140).optional(),
							category: z.string().max(24).optional()
						})
					)
					.min(1)
					.max(50)
			}
		},
		async ({ playlistUrl, epgUrl, picks }) =>
			attempt(async () => {
				const p = await fetchM3u(playlistUrl);
				const guideUrl = epgUrl ?? p.epgUrl;
				const existing = new Set((await listChannels()).map((c) => c.id));
				const added: string[] = [];
				const failed: Array<{ match: string; reason: string }> = [];
				for (const pick of picks) {
					const e = findEntry(p.entries, pick.match);
					if (!e) {
						failed.push({ match: pick.match, reason: 'not in the playlist' });
						continue;
					}
					let id = slugify(e.name);
					for (let n = 2; existing.has(id); n += 1) id = `${slugify(e.name)}-${n}`;
					const name = (pick.name ?? e.name).toUpperCase().slice(0, 24);
					try {
						await createChannel({
							id,
							num: pick.num,
							name,
							kind: 'live',
							blurb: pick.blurb,
							category: pick.category ?? e.group?.split(/[;,]/)[0]?.slice(0, 24),
							anchorEpoch: Math.floor(Date.now() / 1000),
							items: [{ id: 'stream', title: e.name, source: { kind: 'hls', url: e.url }, durationSec: 0 }],
							live: { epgUrl: e.tvgId ? guideUrl : undefined, epgId: e.tvgId, logo: e.logo }
						});
						existing.add(id);
						added.push(`${pick.num} ${name} (${id})${e.tvgId && guideUrl ? '' : ' — no guide data'}`);
					} catch (err) {
						failed.push({ match: pick.match, reason: unwrapError(err) });
					}
				}
				return text({ added, failed, note: added.length ? 'The TV picks them up within about 10 seconds. Guide titles can take a minute to load.' : undefined });
			})
	);

	server.registerTool(
		'set_live_guide',
		{
			title: 'Set live guide data',
			description:
				'Attach XMLTV guide data to a live channel so the guide and info banner show real show titles. ' +
				'Give the XMLTV URL (.xml or .xml.gz). Without epgId, the tool finds the channel in that file by name ' +
				'(the live channel name or its playlist name) and reports close matches if it is unsure. ' +
				'Use this when a playlist has no guide data of its own, e.g. a free-TV playlist plus that service\'s published XMLTV.',
			inputSchema: {
				id: channelId,
				epgUrl: z.string().url(),
				epgId: z.string().optional().describe('Channel id in the XMLTV file; omit to match by name'),
				matchName: z.string().optional().describe('Name to look for instead of the channel name')
			}
		},
		async ({ id, epgUrl, epgId, matchName }) =>
			attempt(async () => {
				const channel = await queryChannel(id);
				if (channel.kind !== 'live') return rejected(`${id} is not a live channel`);
				let guideId = epgId;
				if (!guideId) {
					const list = xmltvChannels(await fetchXmltv(epgUrl));
					const wanted = [matchName, channel.items[0]?.title, channel.name].filter(Boolean).map((n) => channelKey(n!));
					const hit = list.find((c) => c.names.some((n) => wanted.includes(channelKey(n))));
					if (!hit) {
						const near = list
							.filter((c) => c.names.some((n) => wanted.some((w) => w && (channelKey(n).includes(w) || w.includes(channelKey(n))))))
							.slice(0, 10)
							.map((c) => ({ epgId: c.id, names: c.names }));
						return text({ matched: false, looked_for: wanted, channelsInFile: list.length, closeMatches: near, hint: 'Call again with epgId or matchName.' });
					}
					guideId = hit.id;
				}
				const c = await (await channelHandle(id)).executeUpdate(setLive, { args: [{ live: { epgUrl, epgId: guideId } }] });
				return text(`Guide data set: ${epgUrl} → ${guideId}. Titles appear on the guide within a minute.\n\n${JSON.stringify(outline(c), null, 2)}`);
			})
	);

	server.registerTool(
		'forget_connection',
		{
			title: 'Forget connection',
			description: 'Unpair an agent app connection (see box_status.connections). It must pair again with the code on channel 0.',
			inputSchema: { clientId: z.string() }
		},
		async ({ clientId }) =>
			attempt(async () => {
				if (!oauth) return text('This box has no public URL, so there are no paired connections.');
				return text(oauth.forget(clientId) ? `Forgot ${clientId}. Its tokens no longer work.` : `No connection ${clientId}.`);
			})
	);

	return server;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '4mb' }));

app.get('/healthz', (_req, res) => {
	res.json({ ok: true });
});

// Behind Tailscale Funnel every request comes from loopback; trust its X-Forwarded-For.
app.set('trust proxy', 'loopback');

const resourceMetadataUrl = PUBLIC_MCP_URL ? getOAuthProtectedResourceMetadataUrl(PUBLIC_MCP_URL) : null;
if (oauth && PUBLIC_MCP_URL) {
	app.use(
		mcpAuthRouter({
			provider: oauth,
			issuerUrl: new URL(PUBLIC_MCP_URL.origin),
			resourceServerUrl: PUBLIC_MCP_URL,
			resourceName: 'Retro Cable Box',
			serviceDocumentationUrl: new URL('https://github.com/perpetual-static/retro-cable-box#readme')
		})
	);
	app.use(oauth.pairRouter());
}

app.use('/mcp', async (req, res, next) => {
	if (!TOKEN) return next();
	const auth = req.headers.authorization ?? '';
	if (auth === `Bearer ${TOKEN}`) return next();
	if (oauth && /^bearer /i.test(auth)) {
		try {
			await oauth.verifyAccessToken(auth.slice(7).trim());
			return next();
		} catch {
			// falls through to 401
		}
	}
	if (resourceMetadataUrl) res.set('WWW-Authenticate', `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl}"`);
	res.status(401).json({ error: 'unauthorized' });
});

app.post('/mcp', async (req, res) => {
	const server = buildServer();
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
	res.on('close', () => {
		void transport.close();
		void server.close();
	});
	try {
		await server.connect(transport);
		await transport.handleRequest(req, res, req.body);
	} catch (err) {
		console.error('[box-mcp] request error:', err);
		if (!res.headersSent) {
			res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
		}
	}
});

const methodNotAllowed = (_req: express.Request, res: express.Response): void => {
	res.status(405).set('Allow', 'POST').end();
};
app.get('/mcp', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);

const port = Number(process.env.MCP_PORT ?? 8750);
app.listen(port, () => {
	console.log(
		`[box-mcp] listening on :${port} (POST /mcp)${TOKEN ? ' · bearer token required' : ''}${oauth ? ` · OAuth pairing for ${PUBLIC_MCP_URL!.href}` : ''}`
	);
});
