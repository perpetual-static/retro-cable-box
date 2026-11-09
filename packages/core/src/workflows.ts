/**
 * Temporal workflows. Temporal owns *what* a channel is and *when* it changes;
 * it is never in the playback path (the API caches `getSchedule`, the player
 * does the clock math locally).
 *
 *   channelWorkflow  `channel-<id>`  entity: one Channel
 *   lineupWorkflow   `lineup`        entity: box name, channel list, notices
 *   ingestWorkflow   `ingest-…`      resolves sources → items, signals the channel
 */

import {
	allHandlersFinished,
	condition,
	continueAsNew,
	defineQuery,
	defineSignal,
	defineUpdate,
	getExternalWorkflowHandle,
	proxyActivities,
	setHandler,
	uuid4
} from '@temporalio/workflow';
import type { Channel, Item, LineupState, Notice, SourceRequest } from './types';
import type { BoxActivities, ChannelHealth, PluginUpdate, ResolvedItem } from './activities';
import { flatten, type FlatSchedule } from './schedule';
import * as M from './mutations';

const MUTATIONS_PER_RUN = 500;
const nowSec = (): number => Date.now() / 1000; // deterministic inside a workflow

// ── channel ──────────────────────────────────────────────────────────────────

export const getChannel = defineQuery<Channel>('getChannel');
export const getSchedule = defineQuery<FlatSchedule>('getSchedule');

export const updateChannel = defineUpdate<Channel, [M.UpdateChannelArgs]>('updateChannel');
export const addItems = defineUpdate<Channel, [M.AddItemsArgs]>('addItems');
export const removeItem = defineUpdate<Channel, [M.RemoveItemArgs]>('removeItem');
export const moveItem = defineUpdate<Channel, [M.MoveItemArgs]>('moveItem');
export const replaceItems = defineUpdate<Channel, [M.ReplaceItemsArgs]>('replaceItems');
export const setAnchor = defineUpdate<Channel, [M.SetAnchorArgs]>('setAnchor');
export const setRules = defineUpdate<Channel, [M.SetRulesArgs]>('setRules');
export const setLive = defineUpdate<Channel, [M.SetLiveArgs]>('setLive');
export const setBubbles = defineUpdate<Channel, [M.SetBubblesArgs]>('setBubbles');
export const repairItems = defineUpdate<Channel, [M.RepairItemsArgs]>('repairItems');

/** Ingest results arrive as a signal (workflows can't call updates on each other). */
export const ingestedItems = defineSignal<[Item[]]>('ingestedItems');

export interface ChannelWorkflowInput {
	channel: Channel;
}

export async function channelWorkflow(input: ChannelWorkflowInput): Promise<void> {
	let channel = input.channel;
	let mutations = 0;

	setHandler(getChannel, () => channel);
	setHandler(getSchedule, () => flatten(channel));

	const wire = <A>(
		def: ReturnType<typeof defineUpdate<Channel, [A]>>,
		reducer: (c: Channel, a: A, now: number) => Channel,
		validator: (c: Channel, a: A) => void
	): void => {
		setHandler(
			def,
			(args: A): Channel => {
				channel = reducer(channel, args, nowSec());
				mutations += 1;
				return channel;
			},
			{ validator: (args: A): void => validator(channel, args) }
		);
	};

	wire(updateChannel, M.updateChannel, M.validateUpdateChannel);
	wire(addItems, M.addItems, M.validateAddItems);
	wire(removeItem, M.removeItem, M.validateRemoveItem);
	wire(moveItem, M.moveItem, M.validateMoveItem);
	wire(replaceItems, M.replaceItems, M.validateReplaceItems);
	wire(setAnchor, M.setAnchor, M.validateSetAnchor);
	wire(setRules, M.setRules, M.validateSetRules);
	wire(setLive, M.setLive, M.validateSetLive);
	wire(setBubbles, M.setBubbles, M.validateSetBubbles);
	wire(repairItems, M.repairItems, M.validateRepairItems);

	setHandler(ingestedItems, (items: Item[]) => {
		// Keep what is valid and new; a bad item never blocks the rest.
		const ids = new Set(channel.items.map((i) => i.id));
		const fresh = items.filter((i) => {
			if (ids.has(i.id)) return false;
			try {
				M.assertItem(i);
				return true;
			} catch {
				return false;
			}
		});
		if (fresh.length === 0) return;
		const room = M.LIMITS.itemsPerChannel - channel.items.length;
		channel = M.addItems(channel, { items: fresh.slice(0, Math.max(0, room)) }, nowSec());
		mutations += 1;
	});

	await condition(() => mutations >= MUTATIONS_PER_RUN);
	await condition(allHandlersFinished);
	await continueAsNew<typeof channelWorkflow>({ channel });
}

export const channelWorkflowId = (id: string): string => `channel-${id}`;
export const CHANNEL_WORKFLOW_TYPE = 'channelWorkflow';

// ── lineup ───────────────────────────────────────────────────────────────────

export const LINEUP_WORKFLOW_ID = 'lineup';

export const getLineup = defineQuery<LineupState>('getLineup');
export const addChannel = defineUpdate<LineupState, [M.ChannelIdArgs]>('addChannel');
export const removeChannel = defineUpdate<LineupState, [M.ChannelIdArgs]>('removeChannel');
export const postNotice = defineUpdate<LineupState, [M.PostNoticeArgs]>('postNotice');
export const dismissNotice = defineUpdate<LineupState, [M.DismissNoticeArgs]>('dismissNotice');
export const setBoxName = defineUpdate<LineupState, [M.SetBoxNameArgs]>('setBoxName');
export const installPlugin = defineUpdate<LineupState, [M.InstallPluginArgs]>('installPlugin');
export const removePlugin = defineUpdate<LineupState, [M.RemovePluginArgs]>('removePlugin');
/** For workflows (healthcheck, updater) that need to post a notice. */
export const noticeSignal = defineSignal<[Notice]>('notice');

export interface LineupWorkflowInput {
	state: LineupState;
}

export async function lineupWorkflow(input: LineupWorkflowInput): Promise<void> {
	let state = input.state;
	let mutations = 0;

	setHandler(getLineup, () => state);

	const wire = <A>(
		def: ReturnType<typeof defineUpdate<LineupState, [A]>>,
		reducer: (l: LineupState, a: A) => LineupState,
		validator: (l: LineupState, a: A) => void
	): void => {
		setHandler(
			def,
			(args: A): LineupState => {
				state = reducer(state, args);
				mutations += 1;
				return state;
			},
			{ validator: (args: A): void => validator(state, args) }
		);
	};

	wire(addChannel, M.addChannel, M.validateAddChannel);
	wire(removeChannel, M.removeChannel, M.validateRemoveChannel);
	wire(postNotice, M.postNotice, M.validatePostNotice);
	wire(dismissNotice, M.dismissNotice, M.validateDismissNotice);
	wire(setBoxName, M.setBoxName, M.validateSetBoxName);
	wire(installPlugin, M.installPlugin, M.validateInstallPlugin);
	wire(removePlugin, M.removePlugin, M.validateRemovePlugin);

	setHandler(noticeSignal, (notice: Notice) => {
		try {
			M.validatePostNotice(state, { notice });
			state = M.postNotice(state, { notice });
			mutations += 1;
		} catch {
			// a malformed notice from a workflow is dropped, never fatal
		}
	});

	await condition(() => mutations >= MUTATIONS_PER_RUN);
	await condition(allHandlersFinished);
	await continueAsNew<typeof lineupWorkflow>({ state });
}

// ── ingest ───────────────────────────────────────────────────────────────────

const acts = proxyActivities<BoxActivities>({
	startToCloseTimeout: '2 minutes',
	retry: { maximumAttempts: 4, initialInterval: '2s', nonRetryableErrorTypes: ['SourceNotFound', 'SourceUnplayable'] }
});

export interface IngestInput {
	channelId: string;
	requests: SourceRequest[];
}
export interface IngestResult {
	added: { id: string; title: string; durationSec: number }[];
	failed: { source?: SourceRequest['source']; reason: string }[];
}

export async function ingestWorkflow(input: IngestInput): Promise<IngestResult> {
	const result: IngestResult = { added: [], failed: [] };
	const resolved: Item[] = [];

	// Resolve a few at a time: archive.org is kind to polite clients.
	const CONCURRENCY = 4;
	for (let i = 0; i < input.requests.length; i += CONCURRENCY) {
		const batch = input.requests.slice(i, i + CONCURRENCY);
		const settled = await Promise.allSettled(batch.map((r) => acts.resolveSource(r)));
		settled.forEach((s, k) => {
			if (s.status === 'fulfilled') {
				for (const r of s.value) {
					const item = toItem(r);
					try {
						M.assertItem(item);
						resolved.push(item);
					} catch (err) {
						result.failed.push({ source: r.source, reason: (err as Error).message });
					}
				}
			} else {
				result.failed.push({ source: batch[k].source, reason: failureMessage(s.reason) });
			}
		});
	}

	if (resolved.length > 0) {
		await getExternalWorkflowHandle(channelWorkflowId(input.channelId)).signal(ingestedItems, resolved);
	}
	result.added = resolved.map((i) => ({ id: i.id, title: i.title, durationSec: i.durationSec }));
	return result;
}

function toItem(r: ResolvedItem): Item {
	return { id: uuid4(), ...r };
}

function failureMessage(err: unknown): string {
	const e = err as { cause?: { message?: string }; message?: string };
	return e?.cause?.message ?? e?.message ?? String(err);
}

// ── health check ("MacGyver") ────────────────────────────────────────────────

export const HEALTHCHECK_SCHEDULE_ID = 'healthcheck-nightly';

const checker = proxyActivities<BoxActivities>({
	startToCloseTimeout: '15 minutes',
	retry: { maximumAttempts: 2 }
});

export interface HealthReport {
	plugins: PluginUpdate[];
	channels: ChannelHealth[];
	repaired: number;
	dead: number;
	revived: number;
	notice: string | null;
}

/**
 * Nightly: check every channel's media. Posts one notice when anything
 * changed, written like a fix-it montage; a warning when a channel lost more
 * than a fifth of its items.
 */
export async function healthcheckWorkflow(): Promise<HealthReport> {
	// New plugin releases first, so new channels get checked tonight too.
	let plugins: PluginUpdate[] = [];
	try {
		plugins = await checker.updatePlugins();
	} catch {
		// a plugin repo being down never stops the health check
	}
	const updated = plugins.filter((p) => p.action === 'updated');
	if (updated.length) {
		await getExternalWorkflowHandle(LINEUP_WORKFLOW_ID).signal(noticeSignal, {
			id: `plugins-${uuid4().slice(0, 8)}`,
			headline: 'Plugins updated',
			body: `New releases installed: ${updated.map((p) => `${p.id} ${p.release ?? ''}`.trim()).join(', ')}.`.slice(0, 400),
			kind: 'update',
			createdAt: Math.floor(Date.now() / 1000)
		});
	}
	const ids = await checker.listChannelIds();
	const channels: ChannelHealth[] = [];
	for (const id of ids) {
		try {
			channels.push(await checker.checkChannel(id));
		} catch {
			// one channel failing to check never stops the rest
		}
	}
	const sum = (k: 'repaired' | 'dead' | 'revived') => channels.reduce((n, c) => n + c[k].length, 0);
	const report: HealthReport = { plugins, channels, repaired: sum('repaired'), dead: sum('dead'), revived: sum('revived'), notice: null };
	if (report.repaired + report.dead + report.revived === 0) return report;

	const hurt = channels.filter((c) => c.total > 0 && c.dead.length / c.total > 0.2);
	const parts: string[] = [];
	if (report.repaired) parts.push(`swapped ${report.repaired} broken link${report.repaired > 1 ? 's' : ''} with a paper clip and a fallback`);
	if (report.revived) parts.push(`brought ${report.revived} back from the dead`);
	if (report.dead) parts.push(`could not save ${report.dead}: ${channels.flatMap((c) => c.dead.map((t) => `${t} (${c.name})`)).slice(0, 4).join(', ')}`);
	const body = `Overnight check: ${parts.join('; ')}.`.slice(0, 400);
	const headline = hurt.length ? `${hurt.map((c) => c.name).join(', ')} lost a lot of shows`.slice(0, 60) : 'MacGyver fixed some things';
	report.notice = `${headline} — ${body}`;
	await getExternalWorkflowHandle(LINEUP_WORKFLOW_ID).signal(noticeSignal, {
		id: `health-${uuid4().slice(0, 8)}`,
		headline,
		body,
		kind: hurt.length ? 'warning' : 'info',
		createdAt: Math.floor(Date.now() / 1000)
	});
	return report;
}
