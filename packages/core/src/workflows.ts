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
	uuid4,
	workflowInfo
} from '@temporalio/workflow';
import type { BlockWindow, Channel, Item, LineupState, Notice, ProposalSummary, SourceRequest } from './types';
import type { BoxActivities, ChannelHealth, Diagnosis, PluginUpdate, ResolvedItem } from './activities';
import { arm, plan } from './blocks';
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
export const setBlock = defineUpdate<Channel, [M.SetBlockArgs]>('setBlock');
export const removeBlock = defineUpdate<Channel, [M.RemoveBlockArgs]>('removeBlock');

/** The TV could not play an item. The channel checks it and repairs or skips it. */
export const playbackFailed = defineSignal<[{ itemId: string }]>('playbackFailed');
export const repairItems = defineUpdate<Channel, [M.RepairItemsArgs]>('repairItems');

/** Ingest results arrive as a signal (workflows can't call updates on each other). */
export const ingestedItems = defineSignal<[Item[]]>('ingestedItems');

export interface ChannelWorkflowInput {
	channel: Channel;
}

const blockActs = proxyActivities<BoxActivities>({ startToCloseTimeout: '1 minute', retry: { maximumAttempts: 3 } });
const repairActs = proxyActivities<BoxActivities>({ startToCloseTimeout: '2 minutes', retry: { maximumAttempts: 2 } });

/** A report about the same item is ignored for this long after a check. */
const REPORT_QUIET_SEC = 10 * 60;

/**
 * One channel, for as long as it exists. It holds the channel's state and
 * changes it in three ways:
 *
 *  - Updates from the agent (validated edits) and ingest results (a signal).
 *  - Programming blocks: a loop of durable timers. At each wake it arms the
 *    blocks that start within LEAD_SEC (copying the other channel's shows
 *    through an activity), announces the ones that start now, and drops the
 *    ones that ended; then it sleeps until the next of those moments. A box
 *    that was off catches up when it starts again.
 *  - Self-repair: the TV signals playbackFailed; an activity checks the item
 *    and looks for its media elsewhere; the workflow swaps the source or skips
 *    the item, and posts a notice.
 */
export async function channelWorkflow(input: ChannelWorkflowInput): Promise<void> {
	let channel = input.channel;
	let mutations = 0;
	const reports: string[] = [];
	const checkedAt = new Map<string, number>();

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
	wire(setBlock, M.setBlock, M.validateSetBlock);
	wire(removeBlock, M.removeBlock, M.validateRemoveBlock);

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

	setHandler(playbackFailed, ({ itemId }) => {
		if (typeof itemId !== 'string' || reports.includes(itemId) || reports.length >= 20) return;
		reports.push(itemId);
	});

	const notice = (headline: string, body: string, kind: Notice['kind']): Promise<void> =>
		getExternalWorkflowHandle(LINEUP_WORKFLOW_ID)
			.signal(noticeSignal, { id: `ch-${channel.id}-${uuid4().slice(0, 8)}`, headline: headline.slice(0, 60), body: body.slice(0, 400), kind, createdAt: Math.floor(nowSec()) })
			.catch(() => undefined);

	/** Arm, announce and drop block windows. Returns when to wake next. */
	async function tendBlocks(): Promise<number | null> {
		const blocksAtPlan = channel.blocks;
		const p = plan(channel.blocks, channel.windows, nowSec());
		let windows: BlockWindow[] = p.keep;
		for (const o of p.toArm) {
			let shows: Item[] = [];
			try {
				shows = await blockActs.showsForBlock(o.block.fromChannel);
			} catch {
				// the other channel is unreachable now; try again at the next wake
			}
			if (shows.length) windows = [...windows, arm(o, shows)];
		}
		if (channel.blocks !== blocksAtPlan) return nowSec(); // edited while we worked: plan again
		const announce = new Set(p.toAnnounce.map((w) => w.key));
		windows = windows.map((w) => (announce.has(w.key) ? { ...w, announced: true } : w)).sort((a, b) => a.startsAt - b.startsAt);
		const before = JSON.stringify((channel.windows ?? []).map((w) => [w.key, !!w.announced]));
		if (JSON.stringify(windows.map((w) => [w.key, !!w.announced])) !== before) channel = M.setWindows(channel, windows);
		for (const w of windows.filter((x) => announce.has(x.key))) {
			const tz = channel.blocks?.find((b) => b.id === w.blockId)?.tz ?? 'UTC';
			await notice(`${w.name} starts now on ${channel.num}`, `${w.name} is on ${channel.num} ${channel.name} until ${localTime(w.endsAt, tz)}.`, 'info');
		}
		return p.wakeAt;
	}

	/** Check one item the TV could not play, and fix or skip it. */
	async function repair(itemId: string): Promise<void> {
		const now = nowSec();
		if (now - (checkedAt.get(itemId) ?? -Infinity) < REPORT_QUIET_SEC) return;
		checkedAt.set(itemId, now);
		const inBlock = (channel.windows ?? []).find((w) => w.items.some((i) => i.id === itemId));
		const item = (inBlock?.items ?? channel.items).find((i) => i.id === itemId);
		if (!item || item.dead || item.source.kind === 'hls') return;
		let d: Diagnosis;
		try {
			d = await repairActs.diagnoseItem(item);
		} catch {
			return;
		}
		if (d.verdict === 'ok' || d.verdict === 'unsure') return;
		if (inBlock) {
			// A block's copy: fix or drop it in this airing only.
			const items = inBlock.items
				.map((i) => (i.id !== itemId ? i : d.verdict === 'repaired' && d.source ? { ...i, source: d.source, durationSec: d.durationSec ?? i.durationSec } : null))
				.filter((i): i is Item => i !== null);
			channel = M.setWindows(channel, (channel.windows ?? []).map((w) => (w.key === inBlock.key ? { ...w, items } : w)));
		} else if (d.verdict === 'repaired' && d.source) {
			channel = M.repairItems(channel, { replace: [{ itemId, source: d.source, durationSec: d.durationSec }] }, nowSec());
		} else {
			channel = M.repairItems(channel, { dead: [itemId] }, nowSec());
		}
		mutations += 1;
		if (d.verdict === 'repaired') await notice(`MacGyver fixed ${channel.name}`, `"${item.title}" would not play; found it somewhere else.`, 'info');
		else await notice(`${channel.name} lost a show`, `"${item.title}" can no longer be reached; the channel skips it now.`, 'warning');
	}

	for (;;) {
		const wakeAt = await tendBlocks();
		const blocksSeen = channel.blocks;
		const wake = (): boolean =>
			mutations >= MUTATIONS_PER_RUN || channel.blocks !== blocksSeen || reports.length > 0 || workflowInfo().continueAsNewSuggested;
		// A durable timer: it survives restarts, and a box that was off wakes late and catches up.
		if (wakeAt === null) await condition(wake);
		else await condition(wake, Math.max(1000, (wakeAt - nowSec()) * 1000));
		while (reports.length) await repair(reports.shift()!);
		if (mutations >= MUTATIONS_PER_RUN || workflowInfo().continueAsNewSuggested) break;
	}
	await condition(allHandlersFinished);
	await continueAsNew<typeof channelWorkflow>({ channel });
}

/** "11:00 AM" in the block's time zone, for notices. */
function localTime(epoch: number, tz: string): string {
	return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(epoch * 1000));
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
/** A proposal workflow puts its card on the TV, and takes it down. */
export const proposalOpened = defineSignal<[ProposalSummary]>('proposalOpened');
export const proposalClosed = defineSignal<[string]>('proposalClosed');

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

	setHandler(proposalOpened, (p: ProposalSummary) => {
		const others = (state.proposals ?? []).filter((x) => x.id !== p.id);
		state = { ...state, proposals: [...others, { ...p, titles: [...p.titles] }].slice(-10) };
		mutations += 1;
	});
	setHandler(proposalClosed, (id: string) => {
		if (!(state.proposals ?? []).some((x) => x.id === id)) return;
		state = { ...state, proposals: (state.proposals ?? []).filter((x) => x.id !== id) };
		mutations += 1;
	});

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

/** Resolve sources to items, a few at a time (archive.org is kind to polite clients). */
async function resolveAll(requests: SourceRequest[]): Promise<{ items: Item[]; failed: IngestResult['failed'] }> {
	const items: Item[] = [];
	const failed: IngestResult['failed'] = [];
	const CONCURRENCY = 4;
	for (let i = 0; i < requests.length; i += CONCURRENCY) {
		const batch = requests.slice(i, i + CONCURRENCY);
		const settled = await Promise.allSettled(batch.map((r) => acts.resolveSource(r)));
		settled.forEach((s, k) => {
			if (s.status === 'fulfilled') {
				for (const r of s.value) {
					const item = toItem(r);
					try {
						M.assertItem(item);
						items.push(item);
					} catch (err) {
						failed.push({ source: r.source, reason: (err as Error).message });
					}
				}
			} else {
				failed.push({ source: batch[k].source, reason: failureMessage(s.reason) });
			}
		});
	}
	return { items, failed };
}

export async function ingestWorkflow(input: IngestInput): Promise<IngestResult> {
	const { items, failed } = await resolveAll(input.requests);
	if (items.length > 0) {
		await getExternalWorkflowHandle(channelWorkflowId(input.channelId)).signal(ingestedItems, items);
	}
	return { added: items.map((i) => ({ id: i.id, title: i.title, durationSec: i.durationSec })), failed };
}

function toItem(r: ResolvedItem): Item {
	return { id: uuid4(), ...r };
}

function failureMessage(err: unknown): string {
	const e = err as { cause?: { message?: string }; message?: string };
	return e?.cause?.message ?? e?.message ?? String(err);
}

// ── proposals: a channel waits for the owner's OK on the TV ─────────────────

export const proposalWorkflowId = (id: string): string => `proposal-${id}`;

export interface ProposalInput {
	/** The channel as proposed (no items yet; they come from `sources`). */
	channel: Channel;
	sources: SourceRequest[];
	/** How long the card waits on the TV before the proposal expires. */
	expiresInSec: number;
	from?: string;
}

export interface ProposalState {
	id: string;
	status: 'resolving' | 'waiting' | 'approved' | 'declined' | 'expired' | 'failed';
	summary?: ProposalSummary;
	reason?: string;
	failed?: IngestResult['failed'];
}

export const getProposal = defineQuery<ProposalState>('getProposal');
/** The owner's answer, from the TV remote (through the box API, never through MCP). */
export const decideProposal = defineUpdate<ProposalState, [{ approve: boolean }]>('decideProposal');

const proposalActs = proxyActivities<BoxActivities>({
	startToCloseTimeout: '1 minute',
	retry: { maximumAttempts: 3, nonRetryableErrorTypes: ['ChannelTaken'] }
});

/**
 * An agent proposes a channel; the owner decides on the TV. The workflow
 * resolves the shows first (so the card shows real titles), puts the card on
 * the TV, and then waits for the remote, for days if it must. OK creates the
 * channel; BACK or the deadline ends it. The wait costs nothing while it runs.
 */
export async function proposalWorkflow(input: ProposalInput): Promise<ProposalState> {
	const id = input.channel.id;
	const state: ProposalState = { id, status: 'resolving' };
	let decision: boolean | undefined;
	setHandler(getProposal, () => state);
	setHandler(
		decideProposal,
		({ approve }) => {
			decision = !!approve;
			return state;
		},
		{
			validator: (_args: { approve: boolean }) => {
				if (state.status !== 'waiting') throw new Error(`proposal ${id} is ${state.status}`);
				if (decision !== undefined) throw new Error(`proposal ${id} already has an answer`);
			}
		}
	);

	const { items, failed } = await resolveAll(input.sources);
	state.failed = failed;
	if (!items.length) {
		state.status = 'failed';
		state.reason = 'none of the sources could be played';
		return state;
	}
	const channel: Channel = { ...input.channel, items };
	const flat = flatten(channel);
	const summary: ProposalSummary = {
		id,
		num: channel.num,
		name: channel.name,
		blurb: channel.blurb,
		from: input.from,
		items: flat.items.length,
		totalSec: flat.totalSec,
		titles: flat.items.slice(0, 5).map((i) => i.title),
		expiresAt: Math.floor(nowSec() + input.expiresInSec)
	};
	state.summary = summary;
	state.status = 'waiting';
	const lineup = getExternalWorkflowHandle(LINEUP_WORKFLOW_ID);
	await lineup.signal(proposalOpened, summary);

	// The human in the loop: wait for the remote, up to the deadline.
	const answered = await condition(() => decision !== undefined, input.expiresInSec * 1000);
	await lineup.signal(proposalClosed, id);

	const post = (headline: string, body: string, kind: Notice['kind']): Promise<void> =>
		lineup.signal(noticeSignal, { id: `proposal-${id}-${uuid4().slice(0, 6)}`, headline, body, kind, createdAt: Math.floor(nowSec()) });

	if (!answered) {
		state.status = 'expired';
		return state;
	}
	if (!decision) {
		state.status = 'declined';
		return state;
	}
	try {
		await proposalActs.createApprovedChannel({ ...channel, anchorEpoch: Math.floor(nowSec()) });
	} catch (err) {
		state.status = 'failed';
		state.reason = failureMessage(err);
		await post(`Could not add ${channel.name}`, state.reason.slice(0, 400), 'warning');
		return state;
	}
	state.status = 'approved';
	await post(`New channel: ${channel.num} ${channel.name}`.slice(0, 60), `Approved on the TV. ${summary.items} shows, starting now.`, 'update');
	return state;
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
