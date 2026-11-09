/**
 * Temporal client + box operations shared by every non-worker process (MCP,
 * API) and by the worker's boot-time seeding. Connection details are env-driven.
 */

import { Client, Connection, type WorkflowHandle } from '@temporalio/client';
import type { Channel, InstalledPlugin, LineupFile, LineupFileChannel, LineupState, PluginManifest, SourceRequest } from './types';
import { checkManifest, currentRelease, fetchManifest, newChannels, parseSource, toInstalled } from './plugins';
import {
	CHANNEL_WORKFLOW_TYPE,
	LINEUP_WORKFLOW_ID,
	addChannel,
	installPlugin as installPluginUpdate,
	removePlugin as removePluginUpdate,
	addItems,
	channelWorkflow,
	channelWorkflowId,
	getChannel,
	getLineup,
	getSchedule,
	healthcheckWorkflow,
	ingestWorkflow,
	lineupWorkflow,
	removeChannel as removeChannelUpdate,
	type HealthReport,
	type IngestResult
} from './workflows';
import type { FlatSchedule } from './schedule';
import { assertChannel } from './mutations';

export const TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE ?? 'box';
const ADDRESS = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
const NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? 'box';

export const temporalConfig = { address: ADDRESS, namespace: NAMESPACE, taskQueue: TASK_QUEUE };

let cached: Client | undefined;

export async function getClient(): Promise<Client> {
	if (cached) return cached;
	const connection = await Connection.connect({ address: ADDRESS });
	cached = new Client({ connection, namespace: NAMESPACE });
	return cached;
}

/** Dig the validator's reason out of the SDK's "Workflow Update failed" wrapper. */
export function unwrapError(err: unknown): string {
	const cause = (err as { cause?: { message?: unknown } } | null)?.cause;
	if (cause && typeof cause.message === 'string' && cause.message) return cause.message;
	if (err instanceof Error && err.message) return err.message;
	return String(err);
}

// ── lineup ───────────────────────────────────────────────────────────────────

export const DEFAULT_LINEUP: LineupState = { boxName: 'RETRO CABLE', channelIds: [], notices: [] };

/** Start the lineup workflow if it isn't running. Returns true if it was created. */
export async function ensureLineup(): Promise<boolean> {
	const client = await getClient();
	try {
		await client.workflow.start(lineupWorkflow, {
			taskQueue: TASK_QUEUE,
			workflowId: LINEUP_WORKFLOW_ID,
			args: [{ state: DEFAULT_LINEUP }],
			workflowIdConflictPolicy: 'FAIL'
		});
		return true;
	} catch (err) {
		if (/already/i.test(unwrapError(err))) return false;
		throw err;
	}
}

export async function lineupHandle(): Promise<WorkflowHandle<typeof lineupWorkflow>> {
	return (await getClient()).workflow.getHandle(LINEUP_WORKFLOW_ID);
}

export async function queryLineup(): Promise<LineupState> {
	return (await lineupHandle()).query(getLineup);
}

// ── channels ─────────────────────────────────────────────────────────────────

export async function channelHandle(id: string): Promise<WorkflowHandle<typeof channelWorkflow>> {
	return (await getClient()).workflow.getHandle(channelWorkflowId(id));
}

export async function queryChannel(id: string): Promise<Channel> {
	return (await channelHandle(id)).query(getChannel);
}

export async function querySchedule(id: string): Promise<FlatSchedule> {
	return (await channelHandle(id)).query(getSchedule);
}

/** Every channel in the lineup, sorted by number. Missing workflows are skipped. */
export async function listChannels(): Promise<Channel[]> {
	const { channelIds } = await queryLineup();
	const settled = await Promise.allSettled(channelIds.map(queryChannel));
	return settled
		.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []))
		.sort((a, b) => a.num - b.num);
}

export async function listSchedules(): Promise<FlatSchedule[]> {
	const { channelIds } = await queryLineup();
	const settled = await Promise.allSettled(channelIds.map(querySchedule));
	return settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
}

/** Create a channel workflow and add it to the lineup. Rejects on a taken id or number. */
export async function createChannel(channel: Channel): Promise<Channel> {
	assertChannel(channel);
	const existing = await listChannels();
	const clash = existing.find((c) => c.num === channel.num);
	if (clash) throw new Error(`channel ${channel.num} is taken by ${clash.name} (${clash.id})`);
	if (existing.some((c) => c.id === channel.id)) throw new Error(`channel id "${channel.id}" is taken`);
	const client = await getClient();
	await client.workflow.start(channelWorkflow, {
		taskQueue: TASK_QUEUE,
		workflowId: channelWorkflowId(channel.id),
		args: [{ channel }],
		workflowIdConflictPolicy: 'FAIL'
	});
	try {
		await (await lineupHandle()).executeUpdate(addChannel, { args: [{ id: channel.id }] });
	} catch (err) {
		// Don't leave a channel workflow that the lineup can't see; it would block the id.
		await (await channelHandle(channel.id)).terminate('lineup rejected the channel').catch(() => undefined);
		throw err;
	}
	return channel;
}

export async function removeChannel(id: string): Promise<void> {
	await (await lineupHandle()).executeUpdate(removeChannelUpdate, { args: [{ id }] });
	try {
		await (await channelHandle(id)).terminate('removed from lineup');
	} catch {
		// already gone
	}
}

/** Resolve sources into items on a channel. Waits for the result unless `wait` is false. */
export async function ingest(channelId: string, requests: SourceRequest[], wait = true): Promise<IngestResult | null> {
	const client = await getClient();
	const handle = await client.workflow.start(ingestWorkflow, {
		taskQueue: TASK_QUEUE,
		workflowId: `ingest-${channelId}-${Date.now()}`,
		args: [{ channelId, requests }]
	});
	if (!wait) return null;
	const result = await handle.result();
	// The items arrive at the channel by signal; wait until they are applied so
	// the caller reads its own write.
	const ids = new Set(result.added.map((a) => a.id));
	let held = new Set<string>();
	for (let i = 0; i < 50 && ids.size > 0; i += 1) {
		held = new Set((await queryChannel(channelId)).items.map((it) => it.id));
		if ([...ids].every((id) => held.has(id))) break;
		await new Promise((r) => setTimeout(r, 100));
	}
	// Report only what the channel kept (it drops items past its size limit).
	const dropped = result.added.filter((a) => !held.has(a.id));
	return {
		added: result.added.filter((a) => held.has(a.id)),
		failed: [...result.failed, ...dropped.map((a) => ({ reason: `"${a.title}" was not added: the channel is full` }))]
	};
}

/** Run the health check now and wait for its report. */
export async function runHealthcheck(): Promise<HealthReport> {
	const client = await getClient();
	return client.workflow.execute(healthcheckWorkflow, {
		taskQueue: TASK_QUEUE,
		workflowId: `healthcheck-${Date.now()}`,
		args: []
	});
}

/** Existing workflow ids for channels (running), for health checks and cleanup. */
export async function runningChannelIds(): Promise<string[]> {
	const client = await getClient();
	const ids: string[] = [];
	const query = `WorkflowType = '${CHANNEL_WORKFLOW_TYPE}' AND ExecutionStatus = 'Running'`;
	for await (const exec of client.workflow.list({ query })) ids.push(exec.workflowId.replace(/^channel-/, ''));
	return ids;
}

// ── lineup files ─────────────────────────────────────────────────────────────

export function channelFromFile(c: LineupFileChannel, nowSec = Date.now() / 1000): Channel {
	return {
		id: c.id,
		num: c.num,
		name: c.name.toUpperCase(),
		kind: c.kind ?? 'playlist',
		card: c.card,
		blurb: c.blurb,
		category: c.category,
		anchorEpoch: Math.floor(nowSec),
		items: c.items ?? [],
		rules: c.rules,
		live: c.live
	};
}

export interface ImportReport {
	created: string[];
	skipped: { id: string; reason: string }[];
	ingesting: string[];
}

/**
 * Create every channel in a lineup file. Channels whose id or number is taken
 * are skipped. Bare `sources` are ingested in the background (durably).
 */
export async function importLineup(file: LineupFile, opts: { waitForIngest?: boolean } = {}): Promise<ImportReport> {
	if (file?.version !== 1 || !Array.isArray(file.channels)) throw new Error('not a lineup file (version 1)');
	const report: ImportReport = { created: [], skipped: [], ingesting: [] };
	const waits: Promise<unknown>[] = [];
	// Plugins first: their stream recipes must be in place before the channels play.
	for (const p of file.plugins ?? []) {
		try {
			await (await lineupHandle()).executeUpdate(installPluginUpdate, { args: [{ plugin: p }] });
		} catch (err) {
			report.skipped.push({ id: `plugin:${p?.id}`, reason: unwrapError(err) });
		}
	}
	for (const fc of file.channels) {
		try {
			const channel = channelFromFile(fc);
			await createChannel(channel);
			report.created.push(channel.id);
			if (fc.sources?.length) {
				report.ingesting.push(channel.id);
				waits.push(ingest(channel.id, fc.sources, opts.waitForIngest ?? false));
			}
		} catch (err) {
			report.skipped.push({ id: fc.id, reason: unwrapError(err) });
		}
	}
	await Promise.all(waits);
	return report;
}

export async function exportLineup(): Promise<LineupFile> {
	const lineup = await queryLineup();
	const channels = await listChannels();
	return {
		version: 1,
		name: lineup.boxName,
		description: 'Be kind, rewind.',
		...(lineup.plugins?.length ? { plugins: lineup.plugins } : {}),
		channels: channels.map((c) => ({
			id: c.id,
			num: c.num,
			name: c.name,
			kind: c.kind,
			card: c.card,
			blurb: c.blurb,
			category: c.category,
			rules: c.rules,
			live: c.live,
			items: c.items
		}))
	};
}

export { addItems };

// ── plugins ──────────────────────────────────────────────────────────────────

export interface PluginReport {
	plugin: InstalledPlugin;
	/** "installed", "updated" or "unchanged" (no new release). */
	action: 'installed' | 'updated' | 'unchanged';
	channels: ImportReport;
}

async function applyManifest(m: PluginManifest, repo: string | undefined, release: string | undefined, before: InstalledPlugin | undefined): Promise<PluginReport> {
	const offered = before?.offeredChannels ?? [];
	const fresh = newChannels(m, offered);
	const now = Math.floor(Date.now() / 1000);
	const plugin = toInstalled(m, repo, release, [...offered, ...fresh.map((c) => c.id)], now, before?.installedAt ?? now);
	await (await lineupHandle()).executeUpdate(installPluginUpdate, { args: [{ plugin }] });
	// Only channels this install never offered: a channel the owner removed stays removed.
	const channels = fresh.length ? await importLineup({ version: 1, name: m.name, channels: fresh }) : { created: [], skipped: [], ingesting: [] };
	return { plugin, action: before ? 'updated' : 'installed', channels };
}

/**
 * Install a plugin from a GitHub repo (its latest release, or "owner/repo@tag")
 * or a manifest URL. Installing again from the same place updates it.
 */
export async function installPluginFrom(repo: string): Promise<PluginReport> {
	const src = parseSource(repo);
	const release = await currentRelease(src);
	const m = await fetchManifest(src, release);
	const before = (await queryLineup()).plugins?.find((p) => p.id === m.id);
	if (before && before.repo && before.repo !== repo.trim()) throw new Error(`plugin "${m.id}" is already installed from ${before.repo}`);
	return applyManifest(m, repo.trim(), release?.tag, before);
}

/** Install a manifest an agent wrote in place (no repo; it never updates on its own). */
export async function installPluginManifest(m: PluginManifest): Promise<PluginReport> {
	checkManifest(m);
	const before = (await queryLineup()).plugins?.find((p) => p.id === m.id);
	if (before?.repo) throw new Error(`plugin "${m.id}" comes from ${before.repo}; remove it first to replace it with a local manifest`);
	return applyManifest(m, undefined, undefined, before);
}

export async function uninstallPlugin(id: string): Promise<void> {
	await (await lineupHandle()).executeUpdate(removePluginUpdate, { args: [{ id }] });
}

/**
 * Nightly: install new releases of every plugin that came from a GitHub repo.
 * A pinned tag or a plain manifest URL never changes on its own.
 */
export async function updatePlugins(): Promise<Array<{ id: string; action: string; release?: string; error?: string }>> {
	const out: Array<{ id: string; action: string; release?: string; error?: string }> = [];
	for (const p of (await queryLineup()).plugins ?? []) {
		if (!p.repo) continue;
		try {
			const src = parseSource(p.repo);
			if (src.kind !== 'github' || src.pin) continue;
			const release = await currentRelease(src);
			if (!release || release.tag === p.release) {
				out.push({ id: p.id, action: 'unchanged', release: p.release });
				continue;
			}
			const m = await fetchManifest(src, release);
			if (m.id !== p.id) throw new Error(`release ${release.tag} changed the plugin id to "${m.id}"`);
			const r = await applyManifest(m, p.repo, release.tag, p);
			out.push({ id: p.id, action: r.action, release: release.tag });
		} catch (err) {
			out.push({ id: p.id, action: 'failed', error: unwrapError(err) });
		}
	}
	return out;
}
