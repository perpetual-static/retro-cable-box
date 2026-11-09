/**
 * MCP smoke test: connects as an MCP client and builds, edits and removes a
 * throwaway channel end to end. Needs the stack running (`task dev`).
 *   pnpm --filter @box/mcp smoke
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const textOf = (r: CallToolResult): string => (r.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n');

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
	console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures += 1;
}

async function main(): Promise<void> {
	const url = new URL(process.env.MCP_URL ?? `http://127.0.0.1:${process.env.MCP_PORT ?? 8750}/mcp`);
	const headers: Record<string, string> = process.env.MCP_TOKEN ? { authorization: `Bearer ${process.env.MCP_TOKEN}` } : {};
	const client = new Client({ name: 'box-smoke', version: '0.0.0' });
	await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
	const call = async (name: string, args: Record<string, unknown> = {}) =>
		(await client.callTool({ name, arguments: args })) as CallToolResult;

	const tools = (await client.listTools()).tools.map((t) => t.name);
	check('tools listed', tools.includes('add_bubbles') && tools.includes('whats_on'), `${tools.length} tools`);

	const list = await call('list_channels');
	check('list_channels', !list.isError && textOf(list).includes('"num"'));

	await call('remove_channel', { id: 'smoke-test', confirm: true }); // leftover from a failed run

	const created = await call('create_channel', {
		id: 'smoke-test',
		num: 990,
		name: 'smoke test',
		sources: [{ source: { kind: 'archive', identifier: 'Cheerios1960', file: 'Cheerios1960.mp4' } }]
	});
	check('create_channel + ingest', !created.isError && textOf(created).includes('added 1'), textOf(created).split('\n')[1]);

	const dup = await call('create_channel', { id: 'smoke-two', num: 990, name: 'DUP' });
	check('number clash rejected', Boolean(dup.isError), textOf(dup));

	const got = JSON.parse(textOf(await call('get_channel', { id: 'smoke-test' })));
	const itemId: string = got.items[0]?.itemId;
	check('get_channel', got.name === 'SMOKE TEST' && Boolean(itemId), `item ${itemId}`);

	const bubbles = await call('add_bubbles', { id: 'smoke-test', itemId, bubbles: [{ atSec: 5, text: 'Cheerios launched in 1941 as CheeriOats.' }] });
	check('add_bubbles', !bubbles.isError && textOf(bubbles).includes('"bubbles": 1'));

	const late = await call('add_bubbles', { id: 'smoke-test', itemId, bubbles: [{ atSec: 9999, text: 'too late' }] });
	check('late bubble rejected by validator', Boolean(late.isError), textOf(late));

	const at = new Date(Date.now() + 3600_000).toISOString();
	const anchored = await call('set_anchor', { id: 'smoke-test', itemId, at });
	check('set_anchor', !anchored.isError);

	const on = await call('whats_on', { id: 'smoke-test', at });
	check('whats_on at the anchored time', textOf(on).includes('Cheerios'), textOf(on).replace(/\s+/g, ' ').slice(0, 140));

	const search = await call('search_archive', { query: 'duck and cover', rows: 3 });
	check('search_archive', !search.isError && textOf(search).includes('identifier'));

	const exported = await call('export_lineup');
	check('export_lineup', textOf(exported).includes('Be kind, rewind'));

	const removed = await call('remove_channel', { id: 'smoke-test', confirm: true });
	check('remove_channel', !removed.isError);

	await client.close();
	if (failures) {
		console.error(`\n${failures} check(s) failed`);
		process.exit(1);
	}
	console.log('\nMCP smoke passed');
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error('smoke failed:', err);
		process.exit(1);
	});
