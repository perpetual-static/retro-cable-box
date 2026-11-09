/**
 * Data model for the Retro Cable Box. Framework-free and shared by every
 * process: the worker (workflow state), the MCP server, the API and the player.
 */

/** Where an item's media lives. */
export type Source =
	| { kind: 'archive'; identifier: string; file?: string } // archive.org item (+ optional file in it)
	| { kind: 'url'; url: string; fallbackUrl?: string } // any direct MP4/WebM/MP3 URL
	| { kind: 'local'; path: string } // file under MEDIA_ROOT on the box
	| { kind: 'hls'; url: string }; // live stream (user-provided)

/** A pop-up trivia bubble shown over an item while it plays. */
export interface Bubble {
	/** Offset into the item, seconds. */
	atSec: number;
	/** One fact, ≤ 90 characters. */
	text: string;
	/** How long it stays up, seconds. Default 6. */
	durationSec?: number;
}

/** One playable thing on a channel. */
export interface Item {
	id: string;
	title: string;
	source: Source;
	/** Resolved by ingest (archive metadata / ffprobe). Items with 0 never air. */
	durationSec: number;
	year?: number;
	tags?: string[];
	bubbles?: Bubble[];
	/** Set by the health check when the media can't be reached; dead items don't air. */
	dead?: boolean;
}

export type ChannelKind =
	| 'playlist' // loops items on the shared clock (the normal case)
	| 'live' // single HLS source, no schedule
	| 'card'; // generated screen, no video

export type CardKind = 'clock' | 'standby' | 'notices';

/** Live channel settings (kind 'live'). The stream is the channel's one hls item. */
export interface LiveInfo {
	/** XMLTV guide data for the program titles on the guide and banner. */
	epgUrl?: string;
	/** This channel's id in that XMLTV file (tvg-id in the M3U). */
	epgId?: string;
	logo?: string;
}

/** One program from XMLTV guide data, epoch seconds. */
export interface EpgProgram {
	title: string;
	start: number;
	stop: number;
	subtitle?: string;
	desc?: string;
}

export interface ScheduleRules {
	/** When set, items air in a seeded shuffle instead of list order. */
	shuffleSeed?: number;
}

/**
 * A programming block: at set times, another channel's shows air on this
 * channel (e.g. Saturday-morning cartoons 7–11, a Halloween takeover). The
 * channel workflow arms each occurrence with a durable timer (see blocks.ts).
 */
export interface ProgrammingBlock {
	id: string;
	/** Shown on the guide and in the start notice, e.g. "SATURDAY MORNING". */
	name: string;
	/** The channel whose shows air in the block. Copied when the block is armed. */
	fromChannel: string;
	/** Days of the week, 0 = Sunday … 6 = Saturday. Give this or `date`. */
	days?: number[];
	/** One date, YYYY-MM-DD (a one-off block, e.g. a premiere night). */
	date?: string;
	/** Local start time, HH:MM (24-hour). */
	start: string;
	durationMin: number;
	/** IANA time zone for `start` and `days`, e.g. "America/New_York". */
	tz: string;
	/** Shuffle the shows for each airing (default true). */
	shuffle?: boolean;
}

/** One armed occurrence of a block: its own copy of the shows, for its time. */
export interface BlockWindow {
	/** blockId + start, e.g. "sat-toons@1794326400". */
	key: string;
	blockId: string;
	name: string;
	startsAt: number;
	endsAt: number;
	items: Item[];
	announced?: boolean;
}

export interface Channel {
	/** Stable slug, e.g. "toon-lab". */
	id: string;
	/** Guide position. Unique across the lineup. */
	num: number;
	/** Uppercase, ≤ 16 chars looks right on the guide. */
	name: string;
	kind: ChannelKind;
	card?: CardKind;
	blurb?: string;
	category?: string;
	/** Shared-clock origin, epoch seconds. */
	anchorEpoch: number;
	items: Item[];
	rules?: ScheduleRules;
	live?: LiveInfo;
	blocks?: ProgrammingBlock[];
	/** Armed block occurrences (the channel workflow keeps these). */
	windows?: BlockWindow[];
}

export interface Notice {
	id: string;
	headline: string;
	body: string;
	kind: 'update' | 'info' | 'warning';
	createdAt: number;
}

/** One extra step before a stream plays (see plugins.ts). */
export interface StreamRecipe {
	/** Regular expression (case-insensitive) for the stream URLs this recipe handles. */
	match: string;
	/** One GET request made on every tune; its JSON response fills {r.…} fields. */
	session?: { url: string; headers?: Record<string, string> };
	/** Template for the playlist URL to play. */
	playlist: string;
}

/** retro-cable-box.json: what a plugin repo publishes in its releases. */
export interface PluginManifest {
	plugin: 1;
	id: string;
	name: string;
	description?: string;
	version?: string;
	streams?: StreamRecipe[];
	/** Channels the plugin offers, in the lineup-file format. */
	channels?: LineupFileChannel[];
}

/** A plugin as the lineup holds it. */
export interface InstalledPlugin {
	id: string;
	name: string;
	description?: string;
	version?: string;
	/** Where it came from ("owner/repo", "owner/repo@tag" or a manifest URL). Absent when an agent wrote it in place. */
	repo?: string;
	/** The release tag installed. */
	release?: string;
	streams: StreamRecipe[];
	/** Channel ids the plugin has offered so far; an update adds only new ones. */
	offeredChannels: string[];
	installedAt: number;
	updatedAt: number;
}

/** A channel an agent proposed, waiting for the owner's OK on the TV. */
export interface ProposalSummary {
	id: string;
	num: number;
	name: string;
	blurb?: string;
	/** Who asked, if the agent said (e.g. the agent app's name). */
	from?: string;
	items: number;
	totalSec: number;
	/** The first few titles, for the card on the TV. */
	titles: string[];
	expiresAt: number;
}

/** Box-level state held by the lineup workflow. */
export interface LineupState {
	boxName: string;
	/** Channel ids in the lineup (details live in each channel workflow). */
	channelIds: string[];
	notices: Notice[];
	/** Plugins an agent installed (absent on boxes from before plugins). */
	plugins?: InstalledPlugin[];
	/** Proposed channels waiting for the owner's OK on the TV. */
	proposals?: ProposalSummary[];
}

/** Portable lineup file: what export/import and the starter pack use. */
export interface LineupFile {
	version: 1;
	name: string;
	description?: string;
	channels: LineupFileChannel[];
	/** Plugins the lineup's channels need. */
	plugins?: InstalledPlugin[];
}

export interface LineupFileChannel {
	id: string;
	num: number;
	name: string;
	kind?: ChannelKind;
	card?: CardKind;
	blurb?: string;
	category?: string;
	rules?: ScheduleRules;
	live?: LiveInfo;
	/** Already-resolved items (export) or bare sources to ingest (hand-written lineups). */
	items?: Item[];
	sources?: SourceRequest[];
}

/** A source plus optional overrides, as given to ingest. */
export interface SourceRequest {
	source: Source;
	title?: string;
	year?: number;
	tags?: string[];
	durationSec?: number;
}
