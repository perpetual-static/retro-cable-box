import { describe, expect, it } from 'vitest';
import { liveAirings, parseM3u, parseXmltv, parseXmltvTime } from '../src/live';

const M3U = `#EXTM3U url-tvg="https://epg.example/guide.xml.gz,https://other/epg.xml"
#EXTINF:-1 tvg-id="rewind.us" tvg-chno="104" tvg-logo="https://img/rw.png" group-title="Classic TV, 90s",90s Rewind
https://streams.example/rewind/master.m3u8?sid=1
#EXTINF:-1 tvg-id="news.us" group-title="News",Local News
#EXTGRP:ignored
https://streams.example/news.m3u8

#EXTINF:0,No Attributes
http://plain.example/live.ts
#EXTINF:-1,Bad Line
rtmp://not-http/stream
`;

describe('parseM3u', () => {
	const p = parseM3u(M3U);
	it('reads the guide URL from the header', () => {
		expect(p.epgUrl).toBe('https://epg.example/guide.xml.gz');
	});
	it('reads entries with attributes, commas inside quotes and plain lines', () => {
		expect(p.entries).toHaveLength(3);
		expect(p.entries[0]).toEqual({
			name: '90s Rewind',
			url: 'https://streams.example/rewind/master.m3u8?sid=1',
			tvgId: 'rewind.us',
			logo: 'https://img/rw.png',
			group: 'Classic TV, 90s',
			chno: 104
		});
		expect(p.entries[1].group).toBe('News');
		expect(p.entries[2]).toMatchObject({ name: 'No Attributes', url: 'http://plain.example/live.ts' });
	});
});

const T = (s: string) => parseXmltvTime(s);

describe('parseXmltv', () => {
	const xml = `<?xml version="1.0"?><tv>
<channel id="rewind.us"><display-name>90s Rewind</display-name></channel>
<programme start="20261108190000 +0000" stop="20261108193000 +0000" channel="rewind.us"><title lang="en">Saved by the Bell</title><sub-title>The Prom</sub-title><desc>Zack &amp; Kelly.</desc></programme>
<programme start="20261108193000 +0000" stop="20261108200000 +0000" channel="rewind.us"><title><![CDATA[Fresh Prince]]></title></programme>
<programme start="20261108150000 -0500" stop="20261108160000 -0500" channel="rewind.us"><title>Step by Step</title></programme>
<programme start="20261108190000 +0000" stop="20261108200000 +0000" channel="news.us"><title>News</title></programme>
<programme start="20261107190000 +0000" stop="20261107200000 +0000" channel="rewind.us"><title>Yesterday</title></programme>
</tv>`;
	const out = parseXmltv(xml, new Set(['rewind.us']), T('20261108180000'), T('20261109000000'));
	it('keeps only wanted channels in the window, sorted, with offsets applied', () => {
		expect([...out.keys()]).toEqual(['rewind.us']);
		expect(out.get('rewind.us')!.map((p) => p.title)).toEqual(['Saved by the Bell', 'Fresh Prince', 'Step by Step']);
		expect(out.get('rewind.us')![2].start).toBe(T('20261108200000'));
	});
	it('decodes entities and reads subtitles', () => {
		expect(out.get('rewind.us')![0]).toMatchObject({ subtitle: 'The Prom', desc: 'Zack & Kelly.' });
	});
});

describe('liveAirings', () => {
	const progs = [
		{ title: 'A', start: 1000, stop: 2000 },
		{ title: 'B', start: 2500, stop: 3000, subtitle: 'Pilot' }
	];
	it('fills gaps and the tail with LIVE blocks', () => {
		const a = liveAirings('u', 'RW', progs, 1500, 4000);
		expect(a.map((x) => [x.item.title, x.startsAt, x.endsAt])).toEqual([
			['A', 1000, 2000],
			['RW LIVE', 2000, 2500],
			['B: Pilot', 2500, 3000],
			['RW LIVE', 3000, 4000]
		]);
		expect(a[0].offsetSec).toBe(500);
		expect(a.every((x) => x.item.url === 'u')).toBe(true);
	});
	it('shows one LIVE block without guide data', () => {
		const a = liveAirings('u', 'RW', undefined, 100, Infinity, 2);
		expect(a).toHaveLength(1);
		expect(a[0]).toMatchObject({ startsAt: 100, endsAt: 3700 });
	});
});

describe('isLiveGap', () => {
	it('marks only stretches without guide data', async () => {
		const { isLiveGap } = await import('../src/live');
		const a = liveAirings('u', 'RW', [{ title: 'A', start: 100, stop: 200 }], 0, 300);
		expect(a.map(isLiveGap)).toEqual([true, false, true]);
	});
});

describe('rewritePlaylist', () => {
	const proxy = (u: string) => `/api/hls?u=${encodeURIComponent(u)}`;
	it('sends nested playlists through the box and segments, keys and maps direct', async () => {
		const { rewritePlaylist } = await import('../src/live');
		const master = [
			'#EXTM3U',
			'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio/en/playlist.m3u8?sid=1"',
			'#EXT-X-STREAM-INF:BANDWIDTH=1',
			'1042180/playlist.m3u8?sid=1&jwt=x',
			''
		].join('\n');
		const out = rewritePlaylist(master, 'https://p.example/ch/1/master.m3u8?jwt=x', proxy).split('\n');
		expect(out[1]).toBe(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="${proxy('https://p.example/ch/1/audio/en/playlist.m3u8?sid=1')}"`);
		expect(out[3]).toBe(proxy('https://p.example/ch/1/1042180/playlist.m3u8?sid=1&jwt=x'));
		const media = ['#EXT-X-KEY:METHOD=AES-128,URI="k/key.bin",IV=0x1', '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:5,', 'seg_1.ts', 'https://cdn.example/seg_2.ts'].join('\n');
		const m = rewritePlaylist(media, 'https://p.example/ch/1/v/playlist.m3u8', proxy).split('\n');
		expect(m[0]).toBe('#EXT-X-KEY:METHOD=AES-128,URI="https://p.example/ch/1/v/k/key.bin",IV=0x1');
		expect(m[1]).toBe('#EXT-X-MAP:URI="https://p.example/ch/1/v/init.mp4"');
		expect(m[3]).toBe('https://p.example/ch/1/v/seg_1.ts');
		expect(m[4]).toBe('https://cdn.example/seg_2.ts');
	});
});

describe('xmltvChannels / channelKey', () => {
	it('lists channels and matches names loosely', async () => {
		const { xmltvChannels, channelKey } = await import('../src/live');
		const xml = `<tv><channel id="6452c814"><display-name>90's Kids</display-name><icon src="x"/></channel><channel id="b"><display-name>B &amp; C</display-name><display-name>BC</display-name></channel></tv>`;
		expect(xmltvChannels(xml)).toEqual([{ id: '6452c814', names: ["90's Kids"] }, { id: 'b', names: ['B & C', 'BC'] }]);
		expect(channelKey("90's Kids")).toBe(channelKey('90s Kids (720p) [Geo-blocked]'));
	});
});
