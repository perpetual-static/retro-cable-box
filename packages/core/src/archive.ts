/**
 * archive.org client: advanced search and item metadata. Used by the worker's
 * ingest activity and the MCP `search_archive` tool. Not imported by workflows.
 */

const UA = 'retro-cable-box/0.1 (+https://github.com/perpetual-static/retro-cable-box)';

export interface ArchiveFile {
	name: string;
	format?: string;
	length?: string;
	source?: string;
	original?: string;
	title?: string;
	size?: string;
}

export interface ArchiveMetadata {
	identifier: string;
	title?: string;
	year?: number;
	licenseurl?: string;
	collection: string[];
	files: ArchiveFile[];
}

export interface ArchiveSearchHit {
	identifier: string;
	title: string;
	year?: number;
	collection: string[];
	downloads?: number;
	licenseurl?: string;
	description?: string;
}

/** Formats Chromium plays, best first. */
const PLAYABLE_FORMATS = ['h.264', 'h.264 IA', 'MPEG4', 'HiRes MPEG4', 'h.264 HD', '512Kb MPEG4', 'VBR MP3', 'MP3'];

const asArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);

function yearOf(v: unknown): number | undefined {
	const m = String(Array.isArray(v) ? v[0] : (v ?? '')).match(/\d{4}/);
	return m ? Number(m[0]) : undefined;
}

/** "554.99" or "01:23:45" or "12:05" → seconds. */
export function parseLength(len: string | undefined): number {
	if (!len) return 0;
	if (len.includes(':')) {
		return len.split(':').reduce((acc, part) => acc * 60 + Number(part), 0) || 0;
	}
	const n = Number(len);
	return Number.isFinite(n) ? n : 0;
}

async function getJson<T>(url: string): Promise<T> {
	const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
	if (!res.ok) throw new Error(`archive.org ${res.status} for ${url}`);
	return (await res.json()) as T;
}

export async function archiveMetadata(identifier: string): Promise<ArchiveMetadata | null> {
	const d = await getJson<{ metadata?: Record<string, unknown>; files?: ArchiveFile[] }>(
		`https://archive.org/metadata/${encodeURIComponent(identifier)}`
	);
	if (!d.metadata) return null;
	const m = d.metadata;
	return {
		identifier,
		title: m.title ? String(Array.isArray(m.title) ? m.title[0] : m.title) : undefined,
		year: yearOf(m.year ?? m.date),
		licenseurl: m.licenseurl ? String(m.licenseurl) : undefined,
		collection: asArray(m.collection).filter((c) => !c.startsWith('fav-')).slice(0, 6),
		files: d.files ?? []
	};
}

export interface PlayableFile {
	file: string;
	title?: string;
	durationSec: number;
	format: string;
}

/**
 * The best playable derivative of every video (or audio) original in an item,
 * in file order. Many PD items hold a whole series, one file per episode.
 */
export function playableFiles(meta: ArchiveMetadata): PlayableFile[] {
	const rank = (f: ArchiveFile): number => {
		const i = PLAYABLE_FORMATS.indexOf(f.format ?? '');
		return i < 0 ? Infinity : i;
	};
	// Group every copy of the same film together. Copies share a stem once the
	// extension and archive.org's suffixes are removed: Film.mpeg (original),
	// Film_edit.mp4 (a second original), Film.mp4 and Film_512kb.mp4 (derivatives).
	const groups = new Map<string, ArchiveFile[]>();
	for (const f of meta.files) {
		if (rank(f) === Infinity) continue;
		const key = stem(f.source === 'derivative' && f.original ? f.original : f.name);
		groups.set(key, [...(groups.get(key) ?? []), f]);
	}
	const hasVideo = [...groups.values()].some((g) => g.some((f) => !/MP3/.test(f.format ?? '')));
	const out: PlayableFile[] = [];
	for (const [original, files] of groups) {
		const best = files
			.filter((f) => !hasVideo || !/MP3/.test(f.format ?? ''))
			.sort((a, b) => rank(a) - rank(b))[0];
		if (!best) continue;
		const titled = files.find((f) => f.title)?.title ?? meta.files.find((f) => stem(f.name) === original && f.title)?.title;
		out.push({
			file: best.name,
			title: titled,
			durationSec: parseLength(best.length ?? files.find((f) => f.length)?.length),
			format: best.format ?? ''
		});
	}
	// DVD rips carry a few-second menu loop next to the film; drop clips under
	// 30s when the item has real programs in it.
	const longest = Math.max(0, ...out.map((f) => f.durationSec));
	const kept = longest >= 300 ? out.filter((f) => f.durationSec >= 30) : out;
	return kept.sort((a, b) => a.file.localeCompare(b.file, undefined, { numeric: true }));
}

/** One named file, if its format can play (any copy, not only the best one). */
export function namedFile(meta: ArchiveMetadata, name: string): PlayableFile | null {
	const f = meta.files.find((x) => x.name === name);
	if (!f || !PLAYABLE_FORMATS.includes(f.format ?? '')) return null;
	const sibling = meta.files.find((x) => stem(x.name) === stem(name) && x.length);
	return { file: f.name, title: f.title, durationSec: parseLength(f.length ?? sibling?.length), format: f.format ?? '' };
}

const SUFFIX = /(_edit|_\d+kb|_ipod|\.ia|_mxf|_fb|_hd|_yt|_youtube|_archive)$/i;

/** "Film_edit.mp4" → "film", "Film.ia.mp4" → "film", "VTS_01_1_512Kb.mp4" → "vts_01_1". */
export function stem(name: string): string {
	let s = name.replace(/\.[a-z0-9]{2,4}$/i, '');
	while (SUFFIX.test(s)) s = s.replace(SUFFIX, '');
	return s.toLowerCase();
}

export async function searchArchive(
	query: string,
	opts: { rows?: number; mediatype?: 'movies' | 'audio'; publicDomainOnly?: boolean } = {}
): Promise<ArchiveSearchHit[]> {
	const parts = [`(${query})`, `mediatype:${opts.mediatype ?? 'movies'}`];
	if (opts.publicDomainOnly) {
		parts.push('(licenseurl:*publicdomain* OR collection:prelinger OR collection:classic_cartoons OR collection:nasa)');
	}
	const params = new URLSearchParams({ q: parts.join(' AND '), rows: String(opts.rows ?? 15), output: 'json' });
	for (const f of ['identifier', 'title', 'year', 'collection', 'downloads', 'licenseurl', 'description']) {
		params.append('fl[]', f);
	}
	params.append('sort[]', 'downloads desc');
	const d = await getJson<{ response: { docs: Record<string, unknown>[] } }>(
		`https://archive.org/advancedsearch.php?${params}`
	);
	return d.response.docs.map((doc) => ({
		identifier: String(doc.identifier),
		title: String(doc.title ?? doc.identifier),
		year: yearOf(doc.year),
		// Items list every user "favorites" collection (fav-*): thousands for popular films.
		collection: asArray(doc.collection).filter((c) => !c.startsWith('fav-')).slice(0, 6),
		downloads: typeof doc.downloads === 'number' ? doc.downloads : undefined,
		licenseurl: doc.licenseurl ? String(doc.licenseurl) : undefined,
		description: doc.description ? String(Array.isArray(doc.description) ? doc.description[0] : doc.description).replace(/<[^>]+>/g, '').slice(0, 200) : undefined
	}));
}
