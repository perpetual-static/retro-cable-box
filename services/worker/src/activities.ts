/**
 * Activity implementations: the only code that talks to archive.org, ffprobe
 * and the disk. Workflows reach them through proxyActivities.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, relative, isAbsolute, basename, extname } from 'node:path';
import { ApplicationFailure } from '@temporalio/common';
import type { BoxActivities, ResolvedItem } from '@box/core/activities';
import type { SourceRequest } from '@box/core/types';
import { archiveMetadata, namedFile, playableFiles } from '@box/core/archive';

import { MEDIA_ROOT } from './config';
import { checkChannel, listChannelIds } from './health';
import { updatePlugins } from '@box/core/client';

const run = promisify(execFile);

const MAX_FILES_PER_ITEM = 200;

const notFound = (msg: string) => ApplicationFailure.create({ type: 'SourceNotFound', message: msg, nonRetryable: true });
const unplayable = (msg: string) => ApplicationFailure.create({ type: 'SourceUnplayable', message: msg, nonRetryable: true });

/** Duration in seconds via ffprobe (reads only the container header). */
export async function probeDuration(target: string): Promise<number> {
	try {
		const { stdout } = await run(
			'ffprobe',
			['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', target],
			{ timeout: 60_000 }
		);
		const n = Number(stdout.trim());
		return Number.isFinite(n) ? n : 0;
	} catch (err) {
		throw unplayable(`ffprobe could not read ${target}: ${(err as Error).message.split('\n')[0]}`);
	}
}

function titleFromPath(p: string): string {
	const base = basename(p, extname(p));
	let name = base;
	try {
		name = decodeURIComponent(base);
	} catch {
		// a literal "%" in a file name
	}
	return name.replace(/[._-]+/g, ' ').trim();
}

async function resolveSource(req: SourceRequest): Promise<ResolvedItem[]> {
	const s = req.source;
	const base = { year: req.year, tags: req.tags };

	if (s.kind === 'archive') {
		const meta = await archiveMetadata(s.identifier);
		if (!meta) throw notFound(`archive.org has no item "${s.identifier}"`);
		const named = s.file ? namedFile(meta, s.file) : null;
		const files = s.file ? (named ? [named] : []) : playableFiles(meta);
		if (files.length === 0) {
			throw unplayable(s.file ? `"${s.file}" is not a playable file in ${s.identifier}` : `${s.identifier} has no playable video`);
		}
		const single = files.length === 1;
		return files.slice(0, MAX_FILES_PER_ITEM).map((f) => ({
			title: req.title && single ? req.title : single ? (meta.title ?? f.title ?? titleFromPath(f.file)) : (f.title ?? titleFromPath(f.file)),
			source: { kind: 'archive', identifier: s.identifier, file: f.file },
			durationSec: single && req.durationSec ? req.durationSec : f.durationSec,
			year: req.year ?? meta.year,
			tags: req.tags
		}));
	}

	if (s.kind === 'url') {
		const durationSec = req.durationSec ?? (await probeDuration(s.url));
		if (!(durationSec > 0)) throw unplayable(`could not find a duration for ${s.url}`);
		return [{ ...base, title: req.title ?? titleFromPath(new URL(s.url).pathname), source: s, durationSec }];
	}

	if (s.kind === 'local') {
		const full = resolve(MEDIA_ROOT, s.path);
		const rel = relative(MEDIA_ROOT, full);
		if (!rel || rel.startsWith('..') || isAbsolute(rel) || isAbsolute(s.path)) {
			throw notFound('local path must be relative to the media folder');
		}
		const durationSec = req.durationSec ?? (await probeDuration(full));
		return [{ ...base, title: req.title ?? titleFromPath(s.path), source: s, durationSec }];
	}

	// Live streams have no duration; they air on 'live' channels.
	return [{ ...base, title: req.title ?? 'LIVE', source: s, durationSec: req.durationSec ?? 0 }];
}

export const activities: BoxActivities = { resolveSource, listChannelIds, checkChannel, updatePlugins };
