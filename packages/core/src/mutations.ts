/**
 * Pure reducers + validators: the only place a channel or the lineup changes.
 * The workflows wire each pair to a Durable Update (validator first; if it
 * throws, state is untouched and the caller gets the reason).
 *
 * Channel reducers take `nowSec` so that edits re-anchor the shared clock and
 * the item on air keeps playing from the same spot.
 */

import type { Bubble, Channel, ChannelKind, CardKind, Item, LineupState, Notice, ScheduleRules, Source, LiveInfo, InstalledPlugin } from './types';
import { checkInstalled, PLUGIN_LIMITS } from './plugins';
import { flatten, reanchor } from './schedule';

export class BoxMutationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BoxMutationError';
	}
}

const fail = (message: string): never => {
	throw new BoxMutationError(message);
};

// ── limits ───────────────────────────────────────────────────────────────────

export const LIMITS = {
	nameLength: 24,
	itemsPerChannel: 2000,
	bubblesPerItem: 40,
	bubbleText: 90,
	notices: 50
};

// ── cloning (no structuredClone in the workflow sandbox) ─────────────────────

function cloneItem(i: Item): Item {
	return {
		...i,
		source: { ...i.source } as Source,
		tags: i.tags ? [...i.tags] : undefined,
		bubbles: i.bubbles ? i.bubbles.map((b) => ({ ...b })) : undefined
	};
}
function cloneChannel(c: Channel): Channel {
	return { ...c, items: c.items.map(cloneItem), rules: c.rules ? { ...c.rules } : undefined };
}

/** Apply a change to the item list, then re-anchor so the current item doesn't jump. */
function withItems(c: Channel, items: Item[], nowSec: number, rules = c.rules): Channel {
	const next: Channel = { ...cloneChannel(c), items, rules };
	next.anchorEpoch = reanchor(flatten(c), flatten(next), nowSec);
	return next;
}

// ── shape checks ─────────────────────────────────────────────────────────────

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KINDS: ChannelKind[] = ['playlist', 'live', 'card'];
const CARDS: CardKind[] = ['clock', 'standby', 'notices'];

function assertSource(s: Source): void {
	if (!s || typeof s !== 'object') fail('source must be an object');
	switch (s.kind) {
		case 'archive':
			if (!s.identifier) fail('archive source needs an identifier');
			break;
		case 'url':
		case 'hls':
			if (!/^https?:\/\//.test(s.url ?? '')) fail(`${s.kind} source needs an http(s) url`);
			break;
		case 'local':
			if (!s.path || s.path.includes('..')) fail('local source needs a path inside the media folder');
			break;
		default:
			fail(`unknown source kind "${(s as { kind: string }).kind}"`);
	}
}

export function assertItem(i: Item): void {
	if (!i || typeof i !== 'object') fail('item must be an object');
	if (!i.id) fail('item.id is required');
	if (!i.title?.trim()) fail('item.title is required');
	if (typeof i.durationSec !== 'number' || !(i.durationSec >= 0)) fail('item.durationSec must be ≥ 0');
	assertSource(i.source);
	if (i.bubbles) assertBubbles(i.bubbles, i.durationSec);
}

function assertBubbles(bubbles: Bubble[], durationSec: number): void {
	if (!Array.isArray(bubbles)) fail('bubbles must be an array');
	if (bubbles.length > LIMITS.bubblesPerItem) fail(`at most ${LIMITS.bubblesPerItem} bubbles per item`);
	for (const b of bubbles) {
		if (!b.text?.trim()) fail('bubble.text is required');
		if (b.text.length > LIMITS.bubbleText) fail(`bubble text must be ≤ ${LIMITS.bubbleText} chars: "${b.text}"`);
		if (!(b.atSec >= 0)) fail('bubble.atSec must be ≥ 0');
		if (durationSec > 0 && b.atSec >= durationSec) fail(`bubble at ${b.atSec}s is past the end of the item (${durationSec}s)`);
	}
}

export function assertChannel(c: Channel): void {
	if (!SLUG.test(c.id ?? '')) fail('channel id must be lowercase kebab-case');
	assertNum(c.num);
	assertName(c.name);
	if (!KINDS.includes(c.kind)) fail(`kind must be one of ${KINDS.join(', ')}`);
	if (c.kind === 'card' && !CARDS.includes(c.card as CardKind)) fail(`card channels need card: ${CARDS.join(' | ')}`);
	if (!Array.isArray(c.items)) fail('items must be an array');
	if (c.kind === 'live') {
		if (c.items.length !== 1 || c.items[0].source?.kind !== 'hls') fail('a live channel holds exactly one hls item (its stream)');
		if (c.live?.epgUrl && !/^https?:\/\//.test(c.live.epgUrl)) fail('live.epgUrl must be an http(s) url');
	}
	if (c.items.length > LIMITS.itemsPerChannel) fail(`a channel holds at most ${LIMITS.itemsPerChannel} items`);
	c.items.forEach(assertItem);
	const ids = new Set<string>();
	for (const i of c.items) {
		if (ids.has(i.id)) fail(`duplicate item id "${i.id}"`);
		ids.add(i.id);
	}
}

function assertNum(num: number): void {
	if (!Number.isInteger(num) || num < 1 || num > 999) fail('channel num must be an integer 1–999');
}
function assertName(name: string): void {
	if (!name?.trim()) fail('channel name is required');
	if (name.length > LIMITS.nameLength) fail(`channel name must be ≤ ${LIMITS.nameLength} chars`);
}
function itemIndex(c: Channel, itemId: string): number {
	const idx = c.items.findIndex((i) => i.id === itemId);
	if (idx < 0) fail(`no item "${itemId}" on channel ${c.id}`);
	return idx;
}

// ── channel: update fields ───────────────────────────────────────────────────

export interface UpdateChannelArgs {
	patch: Partial<{ num: number; name: string; kind: ChannelKind; card: CardKind; blurb: string; category: string }>;
}
export function validateUpdateChannel(c: Channel, a: UpdateChannelArgs): void {
	if (!a.patch || Object.keys(a.patch).length === 0) fail('patch must contain at least one field');
	assertChannel({ ...c, ...a.patch, name: (a.patch.name ?? c.name).toUpperCase() });
}
export function updateChannel(c: Channel, a: UpdateChannelArgs): Channel {
	const next = { ...cloneChannel(c), ...a.patch };
	next.name = next.name.toUpperCase();
	return next;
}

// ── channel: items ───────────────────────────────────────────────────────────

export interface AddItemsArgs {
	items: Item[];
	/** Insert position; defaults to the end. */
	at?: number;
}
export function validateAddItems(c: Channel, a: AddItemsArgs): void {
	if (!Array.isArray(a.items) || a.items.length === 0) fail('items must be a non-empty array');
	a.items.forEach(assertItem);
	if (c.items.length + a.items.length > LIMITS.itemsPerChannel) fail(`a channel holds at most ${LIMITS.itemsPerChannel} items`);
	const ids = new Set(c.items.map((i) => i.id));
	for (const i of a.items) {
		if (ids.has(i.id)) fail(`duplicate item id "${i.id}"`);
		ids.add(i.id);
	}
	if (a.at !== undefined && (!Number.isInteger(a.at) || a.at < 0 || a.at > c.items.length)) {
		fail(`insert position ${a.at} out of range (0..${c.items.length})`);
	}
}
export function addItems(c: Channel, a: AddItemsArgs, nowSec: number): Channel {
	const items = c.items.map(cloneItem);
	items.splice(a.at ?? items.length, 0, ...a.items.map(cloneItem));
	return withItems(c, items, nowSec);
}

export interface RemoveItemArgs {
	itemId: string;
}
export function validateRemoveItem(c: Channel, a: RemoveItemArgs): void {
	itemIndex(c, a.itemId);
}
export function removeItem(c: Channel, a: RemoveItemArgs, nowSec: number): Channel {
	return withItems(c, c.items.filter((i) => i.id !== a.itemId).map(cloneItem), nowSec);
}

export interface MoveItemArgs {
	itemId: string;
	to: number;
}
export function validateMoveItem(c: Channel, a: MoveItemArgs): void {
	itemIndex(c, a.itemId);
	if (!Number.isInteger(a.to) || a.to < 0 || a.to >= c.items.length) {
		fail(`move target ${a.to} out of range (0..${c.items.length - 1})`);
	}
}
export function moveItem(c: Channel, a: MoveItemArgs, nowSec: number): Channel {
	const items = c.items.map(cloneItem);
	const [moved] = items.splice(itemIndex(c, a.itemId), 1);
	items.splice(a.to, 0, moved);
	return withItems(c, items, nowSec);
}

export interface ReplaceItemsArgs {
	items: Item[];
}
export function validateReplaceItems(c: Channel, a: ReplaceItemsArgs): void {
	if (!Array.isArray(a.items)) fail('items must be an array');
	if (a.items.length > 0) validateAddItems({ ...c, items: [] }, { items: a.items });
}
export function replaceItems(c: Channel, a: ReplaceItemsArgs, nowSec: number): Channel {
	return withItems(c, a.items.map(cloneItem), nowSec);
}

// ── channel: clock + rules + bubbles ─────────────────────────────────────────

export interface SetAnchorArgs {
	anchorEpoch: number;
}
export function validateSetAnchor(_c: Channel, a: SetAnchorArgs): void {
	if (!Number.isFinite(a.anchorEpoch)) fail('anchorEpoch must be a number (epoch seconds)');
}
export function setAnchor(c: Channel, a: SetAnchorArgs): Channel {
	return { ...cloneChannel(c), anchorEpoch: a.anchorEpoch };
}

export interface SetRulesArgs {
	rules: ScheduleRules;
}
export function validateSetRules(_c: Channel, a: SetRulesArgs): void {
	if (!a.rules || typeof a.rules !== 'object') fail('rules must be an object');
	const seed = a.rules.shuffleSeed;
	if (seed !== undefined && !Number.isInteger(seed)) fail('shuffleSeed must be an integer');
}
export function setRules(c: Channel, a: SetRulesArgs, nowSec: number): Channel {
	return withItems(c, c.items.map(cloneItem), nowSec, { ...a.rules });
}

export interface SetLiveArgs {
	live: LiveInfo;
}
export function validateSetLive(c: Channel, a: SetLiveArgs): void {
	if (c.kind !== 'live') fail(`${c.id} is not a live channel`);
	if (!a.live || typeof a.live !== 'object') fail('live must be an object');
	if (a.live.epgUrl && !/^https?:\/\//.test(a.live.epgUrl)) fail('live.epgUrl must be an http(s) url');
	if (a.live.epgUrl && !a.live.epgId) fail('live.epgId is required with live.epgUrl');
}
export function setLive(c: Channel, a: SetLiveArgs): Channel {
	return { ...cloneChannel(c), live: { ...c.live, ...a.live } };
}

export interface SetBubblesArgs {
	itemId: string;
	bubbles: Bubble[];
}
export function validateSetBubbles(c: Channel, a: SetBubblesArgs): void {
	const item = c.items[itemIndex(c, a.itemId)];
	assertBubbles(a.bubbles, item.durationSec);
}
export function setBubbles(c: Channel, a: SetBubblesArgs): Channel {
	const next = cloneChannel(c);
	const item = next.items[itemIndex(c, a.itemId)];
	item.bubbles = [...a.bubbles].sort((x, y) => x.atSec - y.atSec).map((b) => ({ ...b }));
	return next;
}

// ── channel: health check repairs ────────────────────────────────────────────

export interface RepairItemsArgs {
	/** Items whose media moved: swap in the new source (and length, if known). */
	replace?: { itemId: string; source: Source; durationSec?: number }[];
	/** Items that can't be reached any more. */
	dead?: string[];
	/** Items that were dead and answer again. */
	alive?: string[];
}
export function validateRepairItems(c: Channel, a: RepairItemsArgs): void {
	for (const r of a.replace ?? []) {
		itemIndex(c, r.itemId);
		assertSource(r.source);
	}
	for (const id of [...(a.dead ?? []), ...(a.alive ?? [])]) itemIndex(c, id);
}
export function repairItems(c: Channel, a: RepairItemsArgs, nowSec: number): Channel {
	const replace = new Map((a.replace ?? []).map((r) => [r.itemId, r]));
	const dead = new Set(a.dead ?? []);
	const alive = new Set(a.alive ?? []);
	const items = c.items.map((i) => {
		const next = cloneItem(i);
		const r = replace.get(i.id);
		if (r) {
			next.source = { ...r.source } as Source;
			if (r.durationSec && r.durationSec > 0) next.durationSec = r.durationSec;
			delete next.dead;
		}
		if (dead.has(i.id)) next.dead = true;
		if (alive.has(i.id)) delete next.dead;
		return next;
	});
	return withItems(c, items, nowSec);
}

// ── lineup ───────────────────────────────────────────────────────────────────

export interface ChannelIdArgs {
	id: string;
}
export function validateAddChannel(l: LineupState, a: ChannelIdArgs): void {
	if (!SLUG.test(a.id ?? '')) fail('channel id must be lowercase kebab-case');
	if (l.channelIds.includes(a.id)) fail(`channel "${a.id}" is already in the lineup`);
}
export function addChannel(l: LineupState, a: ChannelIdArgs): LineupState {
	return { ...l, channelIds: [...l.channelIds, a.id] };
}
export function validateRemoveChannel(l: LineupState, a: ChannelIdArgs): void {
	if (!l.channelIds.includes(a.id)) fail(`no channel "${a.id}" in the lineup`);
}
export function removeChannel(l: LineupState, a: ChannelIdArgs): LineupState {
	return { ...l, channelIds: l.channelIds.filter((id) => id !== a.id) };
}

export interface PostNoticeArgs {
	notice: Notice;
}
export function validatePostNotice(_l: LineupState, a: PostNoticeArgs): void {
	if (!a.notice?.id) fail('notice.id is required');
	if (!a.notice.headline?.trim()) fail('notice.headline is required');
	if (a.notice.headline.length > 60) fail('notice.headline must be ≤ 60 chars');
	if ((a.notice.body ?? '').length > 400) fail('notice.body must be ≤ 400 chars');
}
export function postNotice(l: LineupState, a: PostNoticeArgs): LineupState {
	const notices = [{ ...a.notice }, ...l.notices.filter((n) => n.id !== a.notice.id)].slice(0, LIMITS.notices);
	return { ...l, notices };
}
export interface DismissNoticeArgs {
	id: string;
}
export function validateDismissNotice(l: LineupState, a: DismissNoticeArgs): void {
	if (!l.notices.some((n) => n.id === a.id)) fail(`no notice "${a.id}"`);
}
export function dismissNotice(l: LineupState, a: DismissNoticeArgs): LineupState {
	return { ...l, notices: l.notices.filter((n) => n.id !== a.id) };
}

export interface SetBoxNameArgs {
	boxName: string;
}
export function validateSetBoxName(_l: LineupState, a: SetBoxNameArgs): void {
	if (!a.boxName?.trim() || a.boxName.length > 32) fail('boxName must be 1–32 chars');
}
export function setBoxName(l: LineupState, a: SetBoxNameArgs): LineupState {
	return { ...l, boxName: a.boxName };
}

export interface InstallPluginArgs {
	plugin: InstalledPlugin;
}
export function validateInstallPlugin(l: LineupState, a: InstallPluginArgs): void {
	const p = a.plugin;
	try {
		checkInstalled(p);
	} catch (err) {
		fail((err as Error).message);
	}
	const others = (l.plugins ?? []).filter((x) => x.id !== p.id);
	if (others.length >= PLUGIN_LIMITS.plugins) fail(`a box holds at most ${PLUGIN_LIMITS.plugins} plugins`);
}
/** Install, or replace the plugin with the same id (an update keeps its place in the order). */
export function installPlugin(l: LineupState, a: InstallPluginArgs): LineupState {
	const copy = JSON.parse(JSON.stringify(a.plugin)) as InstalledPlugin;
	const list = l.plugins ?? [];
	const at = list.findIndex((x) => x.id === copy.id);
	return { ...l, plugins: at >= 0 ? list.map((x, i) => (i === at ? copy : x)) : [...list, copy] };
}
export interface RemovePluginArgs {
	id: string;
}
export function validateRemovePlugin(l: LineupState, a: RemovePluginArgs): void {
	if (!(l.plugins ?? []).some((p) => p.id === a.id)) fail(`no plugin "${a.id}"`);
}
export function removePlugin(l: LineupState, a: RemovePluginArgs): LineupState {
	return { ...l, plugins: (l.plugins ?? []).filter((p) => p.id !== a.id) };
}
