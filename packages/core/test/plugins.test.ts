import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkManifest, currentRelease, fetchManifest, isPrivateHost, newChannels, parseSource, recipeFor, resolveStream, toInstalled } from '../src/plugins';
import { installPlugin, removePlugin, validateInstallPlugin } from '../src/mutations';
import type { InstalledPlugin, LineupState, PluginManifest } from '../src/types';

const RECIPE = {
	match: 'streams\\.example/ch-([0-9a-f]{6})\\.m3u8',
	session: { url: 'https://boot.example/start?channel={1}&client={device}' },
	playlist: '{r.server}/channel/{1}/master.m3u8?{r.params}&token={r.token}'
};
const MANIFEST: PluginManifest = {
	plugin: 1,
	id: 'example-sessions',
	name: 'Example Sessions',
	version: '1.0.0',
	streams: [RECIPE],
	channels: [
		{ id: 'retro-one', num: 101, name: 'RETRO ONE', kind: 'live', items: [] },
		{ id: 'retro-two', num: 102, name: 'RETRO TWO', kind: 'live', items: [] }
	]
};
const installed = (over: Partial<InstalledPlugin> = {}): InstalledPlugin => ({ ...toInstalled(MANIFEST, 'someone/plugin', 'v1.0.0', ['retro-one'], 100), ...over });

describe('parseSource', () => {
	it('reads GitHub forms', () => {
		expect(parseSource('someone/plugin')).toEqual({ kind: 'github', owner: 'someone', repo: 'plugin' });
		expect(parseSource('someone/plugin@v2.1.0')).toEqual({ kind: 'github', owner: 'someone', repo: 'plugin', pin: 'v2.1.0' });
		expect(parseSource('https://github.com/someone/plugin.git')).toEqual({ kind: 'github', owner: 'someone', repo: 'plugin' });
		expect(parseSource('https://github.com/someone/plugin/releases/tag/v3')).toMatchObject({ pin: 'v3' });
	});
	it('takes an https manifest URL but not one on the local network', () => {
		expect(parseSource('https://plugins.example/box.json')).toEqual({ kind: 'url', url: 'https://plugins.example/box.json' });
		expect(() => parseSource('https://192.168.1.4/box.json')).toThrow(/own network/);
		expect(() => parseSource('ftp://x')).toThrow(/GitHub repo/);
	});
});

describe('checkManifest', () => {
	it('accepts a good manifest', () => expect(() => checkManifest(MANIFEST)).not.toThrow());
	it('refuses a recipe that matches every stream', () => {
		expect(() => checkManifest({ ...MANIFEST, streams: [{ ...RECIPE, match: 'm3u8' }] })).toThrow(/too broad/);
	});
	it('refuses recipes that call the local network', () => {
		expect(() => checkManifest({ ...MANIFEST, streams: [{ ...RECIPE, session: { url: 'http://10.0.0.5/x?{1}' } }] })).toThrow(/own network/);
		expect(() => checkManifest({ ...MANIFEST, streams: [{ match: RECIPE.match, playlist: 'http://localhost:8760/{1}' }] })).toThrow(/own network/);
	});
	it('refuses {r.…} fields without a session request', () => {
		expect(() => checkManifest({ ...MANIFEST, streams: [{ match: RECIPE.match, playlist: 'https://a.example/{r.x}' }] })).toThrow(/no session/);
	});
	it('needs streams or channels', () => {
		expect(() => checkManifest({ plugin: 1, id: 'empty', name: 'Empty' })).toThrow(/no streams and no channels/);
	});
});

describe('isPrivateHost', () => {
	it('knows LAN, loopback, tailnet and mDNS names', () => {
		for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.20', '100.100.1.2', 'box.local', 'nas', 'x.tail1.ts.net', '[::1]']) expect(isPrivateHost(h), h).toBe(true);
		for (const h of ['boot.example.com', '8.8.8.8', '172.32.0.1']) expect(isPrivateHost(h), h).toBe(false);
	});
});

describe('resolveStream', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('passes a URL through when no recipe matches', async () => {
		expect(await resolveStream([installed()], 'https://other.example/a.m3u8')).toEqual({ url: 'https://other.example/a.m3u8', plugin: null });
	});

	it('makes the session request and fills the playlist template', async () => {
		const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ server: 'https://edge.example', params: 'a=1&b=2', token: 'T' })));
		vi.stubGlobal('fetch', fetchMock);
		const r = await resolveStream([installed()], 'https://streams.example/ch-abc123.m3u8');
		expect(r).toEqual({ url: 'https://edge.example/channel/abc123/master.m3u8?a=1&b=2&token=T', plugin: 'example-sessions' });
		expect(fetchMock.mock.calls[0][0]).toMatch(/^https:\/\/boot\.example\/start\?channel=abc123&client=[0-9a-f-]{36}$/);
	});

	it('fails with the reason when the response lacks a field', async () => {
		vi.stubGlobal('fetch', async () => new Response('{"server":"https://edge.example"}'));
		await expect(resolveStream([installed()], 'https://streams.example/ch-abc123.m3u8')).rejects.toThrow(/r\.params/);
	});

	it('refuses a response that points the playlist at the local network', async () => {
		vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ server: 'http://192.168.1.1', params: '', token: '' })));
		await expect(resolveStream([installed()], 'https://streams.example/ch-abc123.m3u8')).rejects.toThrow(/own network/);
	});

	it('uses the first plugin in install order', () => {
		const second = installed({ id: 'second' });
		expect(recipeFor([installed(), second], 'https://streams.example/ch-abc123.m3u8')?.plugin.id).toBe('example-sessions');
	});
});

describe('plugin channels and lineup state', () => {
	it('offers only channels it never offered before', () => {
		expect(newChannels(MANIFEST, ['retro-one']).map((c) => c.id)).toEqual(['retro-two']);
	});

	it('installs, replaces in place, and removes', () => {
		const l0: LineupState = { boxName: 'X', channelIds: [], notices: [] };
		const l1 = installPlugin(l0, { plugin: installed() });
		const l2 = installPlugin(installPlugin(l1, { plugin: installed({ id: 'other' }) }), { plugin: installed({ release: 'v2.0.0' }) });
		expect(l2.plugins?.map((p) => `${p.id}@${p.release}`)).toEqual(['example-sessions@v2.0.0', 'other@v1.0.0']);
		expect(removePlugin(l2, { id: 'other' }).plugins?.map((p) => p.id)).toEqual(['example-sessions']);
	});

	it('validates what the workflow stores', () => {
		const l: LineupState = { boxName: 'X', channelIds: [], notices: [] };
		expect(() => validateInstallPlugin(l, { plugin: installed({ streams: [{ ...RECIPE, match: '.*' }] }) })).toThrow(/too broad/);
		expect(() => validateInstallPlugin(l, { plugin: installed({ id: 'Bad Id' }) })).toThrow(/kebab/);
	});
});

describe('GitHub releases', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('installs from the latest release, preferring the release asset', async () => {
		const seen: string[] = [];
		vi.stubGlobal('fetch', async (url: string) => {
			seen.push(url);
			if (url.endsWith('/releases/latest'))
				return new Response(JSON.stringify({ tag_name: 'v2.0.0', assets: [{ name: 'retro-cable-box.json', browser_download_url: 'https://github.com/someone/plugin/releases/download/v2.0.0/retro-cable-box.json' }] }));
			return new Response(JSON.stringify(MANIFEST));
		});
		const src = parseSource('someone/plugin');
		const rel = await currentRelease(src);
		expect(rel?.tag).toBe('v2.0.0');
		expect((await fetchManifest(src, rel)).id).toBe('example-sessions');
		expect(seen).toEqual(['https://api.github.com/repos/someone/plugin/releases/latest', 'https://github.com/someone/plugin/releases/download/v2.0.0/retro-cable-box.json']);
	});

	it('reads the file at the tag when the release has no asset, and never asks GitHub for a pinned tag', async () => {
		const seen: string[] = [];
		vi.stubGlobal('fetch', async (url: string) => {
			seen.push(url);
			return new Response(JSON.stringify(MANIFEST));
		});
		const src = parseSource('someone/plugin@v1.0.0');
		await fetchManifest(src, await currentRelease(src));
		expect(seen).toEqual(['https://raw.githubusercontent.com/someone/plugin/v1.0.0/retro-cable-box.json']);
	});

	it('explains a repo with no release', async () => {
		vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }));
		await expect(currentRelease(parseSource('someone/plugin'))).rejects.toThrow(/no published release/);
	});
});
