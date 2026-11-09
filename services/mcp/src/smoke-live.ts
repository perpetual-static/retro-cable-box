/**
 * Live-channel smoke test: inspect an M3U playlist, add its first channel as
 * a live channel, check /api/guide serves the stream and guide data, then
 * remove it (unless KEEP=1).
 *
 *   PLAYLIST=https://…/list.m3u MCP_TOKEN=… pnpm --filter @box/mcp smoke:live
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MCP = `http://127.0.0.1:${process.env.MCP_PORT ?? 8750}/mcp`;
const API = `http://127.0.0.1:${process.env.API_PORT ?? 8760}`;
const PLAYLIST = process.env.PLAYLIST;
const NUM = Number(process.env.NUM ?? 77);
if (!PLAYLIST) throw new Error('Set PLAYLIST to an M3U URL.');

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
	console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failed++;
}

const headers: Record<string, string> = process.env.MCP_TOKEN ? { Authorization: `Bearer ${process.env.MCP_TOKEN}` } : {};
const client = new Client({ name: 'smoke-live', version: '0' });
await client.connect(new StreamableHTTPClientTransport(new URL(MCP), { requestInit: { headers } }));
const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
	const r = await client.callTool({ name, arguments: args });
	return (r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('');
};

const inspected = JSON.parse(await call('inspect_m3u', { url: PLAYLIST, limit: 5 })) as {
	total: number;
	epgUrl: string | null;
	channels: Array<{ name: string; tvgId?: string }>;
};
check('inspect_m3u', inspected.total > 0, `${inspected.total} channels, guide ${inspected.epgUrl ?? 'none'}`);

const first = inspected.channels[0];
const added = JSON.parse(await call('add_live_channels', { playlistUrl: PLAYLIST, picks: [{ match: first.tvgId ?? first.name, num: NUM }] })) as {
	added: string[];
	failed: unknown[];
};
check('add_live_channels', added.added.length === 1, added.added[0] ?? JSON.stringify(added.failed));
const clash = JSON.parse(await call('add_live_channels', { playlistUrl: PLAYLIST, picks: [{ match: first.name, num: NUM }] })) as { failed: Array<{ reason: string }> };
check('number clash rejected', clash.failed[0]?.reason.includes('taken') ?? false, clash.failed[0]?.reason);
const missing = JSON.parse(await call('add_live_channels', { playlistUrl: PLAYLIST, picks: [{ match: 'no such channel', num: NUM + 1 }] })) as { failed: Array<{ reason: string }> };
check('unknown channel reported', missing.failed[0]?.reason === 'not in the playlist');

const id = /\(([a-z0-9-]+)\)/.exec(added.added[0] ?? '')?.[1];
let live: { url: string | null; programs: unknown[] } | undefined;
for (let i = 0; i < 20; i++) {
	const g = (await (await fetch(`${API}/api/guide`)).json()) as { live?: Record<string, { url: string | null; programs: unknown[] }> };
	live = id ? g.live?.[id] : undefined;
	if (live?.url && (!inspected.epgUrl || live.programs.length)) break;
	await new Promise((r) => setTimeout(r, 1500));
}
check('/api/guide has the stream', !!live?.url, live?.url ?? 'missing');
if (inspected.epgUrl) check('/api/guide has guide data', (live?.programs.length ?? 0) > 0, `${live?.programs.length ?? 0} programs`);

if (id && process.env.KEEP !== '1') await call('remove_channel', { id, confirm: true });
await client.close();
console.log(failed ? `Live smoke failed (${failed})` : 'Live smoke passed');
process.exit(failed ? 1 : 0);
