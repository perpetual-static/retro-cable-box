/**
 * Activity interfaces. Implementations live in the worker; workflows only see
 * these types (through proxyActivities).
 */

import type { Item, SourceRequest } from './types';

/** An item before it gets an id. */
export type ResolvedItem = Omit<Item, 'id'>;

export interface BoxActivities {
	/**
	 * Resolve one source to playable items with durations. An archive.org item
	 * with no file named can hold many videos (a series); each becomes an item.
	 * Throws ApplicationFailure type "SourceNotFound" / "SourceUnplayable".
	 */
	resolveSource(request: SourceRequest): Promise<ResolvedItem[]>;

	/** Channel ids in the lineup. */
	listChannelIds(): Promise<string[]>;

	/**
	 * Check every item on a channel can still be reached, repair what it can
	 * ("MacGyver": a fallback URL, the same program in another file), and mark
	 * the rest dead. Applies the result to the channel itself.
	 */
	checkChannel(channelId: string): Promise<ChannelHealth>;

	/** Install new GitHub releases of the installed plugins (see client.updatePlugins). */
	updatePlugins(): Promise<PluginUpdate[]>;
}

export interface PluginUpdate {
	id: string;
	action: string;
	release?: string;
	error?: string;
}

export interface ChannelHealth {
	channelId: string;
	name: string;
	/** Items that had media (cards and empty channels report 0). */
	total: number;
	repaired: string[];
	dead: string[];
	revived: string[];
	/** Could not tell (timeouts, 5xx): left alone until the next check. */
	unsure: number;
}
