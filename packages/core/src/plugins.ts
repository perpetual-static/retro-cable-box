/**
 * Plugins: what the box knows about outside services, installed by an agent.
 *
 * The box ships with no knowledge of any streaming service. A plugin adds it.
 * A plugin is a manifest file (data, never code) that anyone can publish in a
 * GitHub repo as `retro-cable-box.json`:
 *
 *   {
 *     "plugin": 1,
 *     "id": "my-plugin", "name": "My Plugin", "version": "1.0.0",
 *     "streams":  [ StreamRecipe, … ],     extra steps before a stream plays
 *     "channels": [ LineupFileChannel, … ] channels it offers (lineup-file format)
 *   }
 *
 * The owner (through their agent) registers the repo with `install_plugin`. The
 * box creates the plugin's channels and uses its stream recipes on every
 * tune. The repo's GitHub releases control updates: every night the box looks
 * for a new release and installs it.
 *
 * A stream recipe:
 *   match     a regular expression for the stream URLs it handles
 *   session   one GET request the box makes on every tune (optional)
 *   playlist  a template for the playlist URL to play
 *
 * Templates fill these fields:
 *   {1} … {9}       capture groups from `match`
 *   {url}           the stream URL as stored on the channel
 *   {device}        a random id that stays the same while the box runs
 *   {uuid}          a new random id
 *   {r.path.to.x}   a field of the session request's JSON response
 *
 * Browser-safe (fetch and crypto.randomUUID only).
 */

import type { InstalledPlugin, LineupFileChannel, PluginManifest, StreamRecipe } from './types';

export const PLUGIN_LIMITS = {
	plugins: 30,
	streamsPerPlugin: 20,
	channelsPerPlugin: 100,
	template: 2000,
	manifestBytes: 2_000_000,
	responseBytes: 1_000_000,
	timeoutMs: 8000
};

export const MANIFEST_FILE = 'retro-cable-box.json';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HTTP = /^https?:\/\//i;

class PluginError extends Error {}
const fail = (m: string): never => {
	throw new PluginError(m);
};

/** Hosts on the owner's own network. A plugin may not make the box call them. */
export function isPrivateHost(host: string): boolean {
	const h = host.toLowerCase().replace(/^\[|\]$/g, '');
	if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.ts.net')) return true;
	if (!h.includes('.') && !h.includes(':')) return true; // bare LAN names
	const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
	if (v4) {
		const [a, b] = [Number(v4[1]), Number(v4[2])];
		return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
	}
	return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
}

/** A literal host at the start of a template, if it has one before any field. */
function templateHost(t: string): string | null {
	const m = /^https?:\/\/([^/?#{]+)/i.exec(t);
	return m ? m[1].replace(/:\d+$/, '') : null;
}

function checkRecipe(s: StreamRecipe, where: string): void {
	if (!s || typeof s !== 'object') fail(`${where} must be an object`);
	if (typeof s.match !== 'string' || !s.match || s.match.length > 300) fail(`${where}.match must be 1–300 chars`);
	let re: RegExp | undefined;
	try {
		re = new RegExp(s.match, 'i');
	} catch (err) {
		fail(`${where}.match is not a valid regular expression: ${(err as Error).message}`);
	}
	// A recipe must not take over every stream on the box.
	if (re!.test('https://example.com/live/stream.m3u8') || re!.test('http://192.168.1.10/a.m3u8')) fail(`${where}.match is too broad: it matches any stream`);
	if (s.session !== undefined) {
		const url = s.session?.url;
		if (typeof url !== 'string' || !HTTP.test(url) || url.length > PLUGIN_LIMITS.template) fail(`${where}.session.url must be an http(s) template`);
		const host = templateHost(url);
		if (!host) fail(`${where}.session.url must name its host directly`);
		if (isPrivateHost(host!)) fail(`${where}.session.url may not call the owner's own network`);
		for (const [k, v] of Object.entries(s.session.headers ?? {})) {
			if (!/^[A-Za-z0-9-]{1,64}$/.test(k) || typeof v !== 'string' || v.length > 500) fail(`${where}.session header "${k}" is not valid`);
		}
	}
	if (typeof s.playlist !== 'string' || s.playlist.length > PLUGIN_LIMITS.template) fail(`${where}.playlist must be a template ≤ ${PLUGIN_LIMITS.template} chars`);
	if (!HTTP.test(s.playlist) && !/^\{(r\.[A-Za-z0-9_.]+|url)\}/.test(s.playlist)) fail(`${where}.playlist must be an http(s) template or start with a field`);
	const host = templateHost(s.playlist);
	if (host && isPrivateHost(host)) fail(`${where}.playlist may not point at the owner's own network`);
	if (/\{r\./.test(s.playlist) && !s.session) fail(`${where}.playlist uses {r.…} fields but the recipe has no session request`);
}

/** Throws with the reason when a manifest is malformed. */
export function checkManifest(m: PluginManifest): void {
	if (!m || typeof m !== 'object') fail('the manifest must be a JSON object');
	if (m.plugin !== 1) fail('the manifest must say "plugin": 1');
	if (!SLUG.test(m.id ?? '')) fail('the plugin id must be lowercase kebab-case');
	if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 40) fail('the plugin name must be 1–40 chars');
	if ((m.description ?? '').length > 300) fail('the plugin description must be ≤ 300 chars');
	if ((m.version ?? '').length > 32) fail('the plugin version must be ≤ 32 chars');
	if (m.streams !== undefined && !Array.isArray(m.streams)) fail('streams must be a list');
	if (m.channels !== undefined && !Array.isArray(m.channels)) fail('channels must be a list');
	if ((m.streams ?? []).length > PLUGIN_LIMITS.streamsPerPlugin) fail(`a plugin holds at most ${PLUGIN_LIMITS.streamsPerPlugin} stream recipes`);
	if ((m.channels ?? []).length > PLUGIN_LIMITS.channelsPerPlugin) fail(`a plugin offers at most ${PLUGIN_LIMITS.channelsPerPlugin} channels`);
	(m.streams ?? []).forEach((s, i) => checkRecipe(s, `streams[${i}]`));
	(m.channels ?? []).forEach((c, i) => {
		if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !Number.isInteger(c.num)) fail(`channels[${i}] needs an id and a num`);
	});
	if (!(m.streams ?? []).length && !(m.channels ?? []).length) fail('the plugin has no streams and no channels');
}

/** Throws with the reason when an installed plugin (as the lineup holds it) is malformed. */
export function checkInstalled(p: InstalledPlugin): void {
	if (!p || typeof p !== 'object') fail('plugin must be an object');
	if (!SLUG.test(p.id ?? '')) fail('the plugin id must be lowercase kebab-case');
	if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 40) fail('the plugin name must be 1–40 chars');
	if ((p.description ?? '').length > 300 || (p.version ?? '').length > 32) fail('the plugin description or version is too long');
	if (!Array.isArray(p.streams) || p.streams.length > PLUGIN_LIMITS.streamsPerPlugin) fail(`streams must be a list of at most ${PLUGIN_LIMITS.streamsPerPlugin}`);
	p.streams.forEach((s, i) => checkRecipe(s, `streams[${i}]`));
	if (!Array.isArray(p.offeredChannels) || p.offeredChannels.some((id) => typeof id !== 'string')) fail('offeredChannels must be a list of channel ids');
	if ((p.repo ?? '').length > 300 || (p.release ?? '').length > 100) fail('repo or release is too long');
}

/** The installed form: the manifest without its channel list, plus where it came from. */
export function toInstalled(m: PluginManifest, repo: string | undefined, release: string | undefined, offered: string[], now: number, installedAt = now): InstalledPlugin {
	const p: InstalledPlugin = {
		id: m.id,
		name: m.name,
		streams: (m.streams ?? []).map((s) => JSON.parse(JSON.stringify(s)) as StreamRecipe),
		offeredChannels: [...offered],
		installedAt,
		updatedAt: now
	};
	if (m.description) p.description = m.description;
	if (m.version) p.version = m.version;
	if (repo) p.repo = repo;
	if (release) p.release = release;
	return p;
}

// ── where a manifest lives ───────────────────────────────────────────────────
//
// A plugin repo controls its own updates through GitHub releases. The box
// installs the manifest of the latest release (a release asset named
// retro-cable-box.json, or that file at the release tag) and updates only when
// a new release appears. "owner/repo@tag" pins one version and never updates.

export type PluginSource = { kind: 'github'; owner: string; repo: string; pin?: string } | { kind: 'url'; url: string };

/** "owner/repo", "owner/repo@tag", a github.com URL, or an https URL to a manifest .json file. */
export function parseSource(repo: string): PluginSource {
	const r = repo.trim();
	const short = /^([\w.-]+)\/([\w.-]+?)(?:@([\w./-]+))?$/.exec(r);
	if (short) return { kind: 'github', owner: short[1], repo: short[2], ...(short[3] ? { pin: short[3] } : {}) };
	const gh = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|releases\/tag)\/([\w./-]+))?\/?$/.exec(r);
	if (gh) return { kind: 'github', owner: gh[1], repo: gh[2], ...(gh[3] ? { pin: gh[3] } : {}) };
	if (/^https:\/\/[^/]+\/.+\.json(\?.*)?$/i.test(r)) {
		if (isPrivateHost(new URL(r).hostname)) fail("a plugin manifest may not come from the owner's own network");
		return { kind: 'url', url: r };
	}
	return fail('give a GitHub repo ("owner/repo", "owner/repo@tag" or its github.com URL) or an https URL to a manifest .json file');
}

const UA = { 'user-agent': 'RetroCableBox/0.1' };

async function getText(url: string, what: string, accept?: string): Promise<string> {
	const r = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { ...UA, ...(accept ? { accept } : {}) } });
	if (r.status === 404) fail(`${what} not found (${url})`);
	if (!r.ok) fail(`${url} answered HTTP ${r.status}`);
	const text = await r.text();
	if (text.length > PLUGIN_LIMITS.manifestBytes) fail(`${what} is too large`);
	return text;
}

function parseManifest(text: string, url: string): PluginManifest {
	let m: PluginManifest;
	try {
		m = JSON.parse(text) as PluginManifest;
	} catch {
		return fail(`${url} is not valid JSON`);
	}
	checkManifest(m);
	return m;
}

interface GithubRelease {
	tag_name: string;
	assets?: Array<{ name: string; browser_download_url: string }>;
}

/** The release a source points at now: the pin, or the latest GitHub release. Null for a plain URL. */
export async function currentRelease(src: PluginSource): Promise<{ tag: string; assetUrl?: string } | null> {
	if (src.kind === 'url') return null;
	if (src.pin) return { tag: src.pin };
	const api = `https://api.github.com/repos/${src.owner}/${src.repo}/releases/latest`;
	const r = await fetch(api, { signal: AbortSignal.timeout(15_000), headers: { ...UA, accept: 'application/vnd.github+json' } });
	if (r.status === 404) fail(`${src.owner}/${src.repo} has no published release. Publish a GitHub release to install or update the plugin, or pin a tag with "owner/repo@tag".`);
	if (!r.ok) fail(`GitHub answered HTTP ${r.status} for ${src.owner}/${src.repo}`);
	const rel = (await r.json()) as GithubRelease;
	const asset = rel.assets?.find((a) => a.name === MANIFEST_FILE);
	return { tag: rel.tag_name, ...(asset ? { assetUrl: asset.browser_download_url } : {}) };
}

/** The manifest at a release (or at a plain URL). */
export async function fetchManifest(src: PluginSource, release: { tag: string; assetUrl?: string } | null): Promise<PluginManifest> {
	let url: string;
	if (src.kind === 'url') url = src.url;
	else if (release?.assetUrl) url = release.assetUrl;
	else url = `https://raw.githubusercontent.com/${src.owner}/${src.repo}/${encodeURIComponent(release!.tag)}/${MANIFEST_FILE}`;
	return parseManifest(await getText(url, `${MANIFEST_FILE}${release ? ` in release ${release.tag}` : ''}`), url);
}

/** The channels in a manifest that this install has not offered before. */
export function newChannels(m: PluginManifest, offered: string[]): LineupFileChannel[] {
	return (m.channels ?? []).filter((c) => !offered.includes(c.id));
}

// ── resolving a stream ───────────────────────────────────────────────────────

/** The first recipe (in install order) whose pattern matches the URL. */
export function recipeFor(plugins: InstalledPlugin[] | undefined, url: string): { plugin: InstalledPlugin; recipe: StreamRecipe; groups: string[] } | null {
	for (const plugin of plugins ?? []) {
		for (const recipe of plugin.streams) {
			const m = new RegExp(recipe.match, 'i').exec(url);
			if (m) return { plugin, recipe, groups: m.slice(1).map((g) => g ?? '') };
		}
	}
	return null;
}

// Made on first use: the workflow sandbox loads this file too and has no crypto.
let device: string | undefined;

function field(obj: unknown, path: string): string {
	let v: unknown = obj;
	for (const k of path.split('.')) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
	if (v === undefined || v === null || typeof v === 'object') fail(`the session response has no value at r.${path}`);
	return String(v);
}

function fill(template: string, vars: { url: string; groups: string[]; response?: unknown }, encode: boolean): string {
	return template.replace(/\{(\d|url|device|uuid|r\.[A-Za-z0-9_.]+)\}/g, (_all, key: string) => {
		let v: string;
		if (/^\d$/.test(key)) v = vars.groups[Number(key) - 1] ?? '';
		else if (key === 'url') v = vars.url;
		else if (key === 'device') v = device ??= globalThis.crypto.randomUUID();
		else if (key === 'uuid') v = globalThis.crypto.randomUUID();
		else v = field(vars.response, key.slice(2));
		// In the session request URL, values go into query strings: encode them.
		// The playlist template gets values as they are (they often hold whole query strings).
		return encode && key !== 'url' ? encodeURIComponent(v) : v;
	});
}

export interface ResolveResult {
	url: string;
	/** The plugin that changed the URL, or null when none matched. */
	plugin: string | null;
}

/**
 * The playlist URL to play for a stream URL: the URL itself when no recipe
 * matches. Throws with the reason when a matching recipe fails.
 */
export async function resolveStream(plugins: InstalledPlugin[] | undefined, url: string): Promise<ResolveResult> {
	const hit = recipeFor(plugins, url);
	if (!hit) return { url, plugin: null };
	const { plugin, recipe, groups } = hit;
	let response: unknown;
	if (recipe.session) {
		const target = fill(recipe.session.url, { url, groups }, true);
		if (isPrivateHost(new URL(target).hostname)) fail(`${plugin.name}: the session request may not call the owner's own network`);
		const r = await fetch(target, { headers: recipe.session.headers, signal: AbortSignal.timeout(PLUGIN_LIMITS.timeoutMs) });
		if (!r.ok) fail(`${plugin.name}: the session request answered HTTP ${r.status}`);
		const body = await r.text();
		if (body.length > PLUGIN_LIMITS.responseBytes) fail(`${plugin.name}: the session response is too large`);
		try {
			response = JSON.parse(body);
		} catch {
			fail(`${plugin.name}: the session response is not JSON`);
		}
	}
	const out = fill(recipe.playlist, { url, groups, response }, false);
	if (!HTTP.test(out)) fail(`${plugin.name}: the playlist template did not make an http(s) URL`);
	if (isPrivateHost(new URL(out).hostname)) fail(`${plugin.name}: the playlist may not point at the owner's own network`);
	return { url: out, plugin: plugin.id };
}
