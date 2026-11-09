/**
 * OAuth smoke test: does what claude.ai does when you add the box as a
 * connector, from discovery to a tool call, then refresh, revoke and forget.
 *
 * Needs the MCP server running with MCP_TOKEN and PUBLIC_MCP_URL set, e.g.
 *   PUBLIC_MCP_URL=http://127.0.0.1:8750/mcp MCP_TOKEN=… pnpm --filter @box/mcp dev
 *   MCP_TOKEN=… pnpm --filter @box/mcp smoke:oauth
 */

import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { pairingCode } from '@box/core/pairing';

const BASE = process.env.MCP_BASE ?? `http://127.0.0.1:${process.env.MCP_PORT ?? 8750}`;
const MCP = `${BASE}/mcp`;
const TOKEN = process.env.MCP_TOKEN;
if (!TOKEN) throw new Error('Set MCP_TOKEN (the same one the server uses).');
const REDIRECT = 'http://127.0.0.1:9/callback';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
	console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failed++;
}

async function callTool(bearer: string, name: string, args: Record<string, unknown> = {}): Promise<string> {
	const client = new Client({ name: 'smoke-oauth', version: '0' });
	await client.connect(new StreamableHTTPClientTransport(new URL(MCP), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
	try {
		const r = await client.callTool({ name, arguments: args });
		return (r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('');
	} finally {
		await client.close();
	}
}

const form = (data: Record<string, string>): RequestInit => ({
	method: 'POST',
	headers: { 'content-type': 'application/x-www-form-urlencoded' },
	body: new URLSearchParams(data).toString(),
	redirect: 'manual'
});

// 1. An unauthenticated call points at the metadata.
const bare = await fetch(MCP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
const challenge = bare.headers.get('www-authenticate') ?? '';
const prmUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
check('401 names the resource metadata', bare.status === 401 && !!prmUrl, challenge);

// 2. Discovery.
const prm = (await (await fetch(prmUrl!)).json()) as { resource: string; authorization_servers: string[] };
check('protected resource metadata', prm.resource === (process.env.PUBLIC_MCP_URL ?? MCP) && prm.authorization_servers.length === 1, JSON.stringify(prm));
const asUrl = new URL('/.well-known/oauth-authorization-server', prm.authorization_servers[0]);
const as = (await (await fetch(asUrl)).json()) as Record<string, string>;
check('authorization server metadata', !!as.registration_endpoint && !!as.authorization_endpoint && !!as.token_endpoint);

// 3. Dynamic client registration.
const reg = (await (
	await fetch(as.registration_endpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			client_name: 'Smoke Agent',
			redirect_uris: [REDIRECT],
			token_endpoint_auth_method: 'none',
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code']
		})
	})
).json()) as { client_id: string };
check('client registered', !!reg.client_id, reg.client_id);

// 4. Authorize: the pairing page.
const verifier = randomBytes(32).toString('base64url');
const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
const authUrl = new URL(as.authorization_endpoint);
for (const [k, v] of Object.entries({
	response_type: 'code',
	client_id: reg.client_id,
	redirect_uri: REDIRECT,
	code_challenge: codeChallenge,
	code_challenge_method: 'S256',
	state: 'xyzzy',
	resource: MCP
}))
	authUrl.searchParams.set(k, v);
const page = await (await fetch(authUrl)).text();
const requestId = /name="request" value="([^"]+)"/.exec(page)?.[1];
check('pairing page shown', !!requestId && page.includes('Smoke Agent') && page.includes('channel 0'));

// 5. A wrong code is refused; the right one redirects with a code.
const realCode = pairingCode(TOKEN);
const wrongCode = String((Number(realCode) + 1) % 1_000_000).padStart(6, '0');
const wrong = await fetch(`${BASE}/pair`, form({ request: requestId!, code: wrongCode, action: 'pair' }));
check('wrong pairing code refused', wrong.status === 401 && (await wrong.text()).includes('tries left'));
const right = await fetch(`${BASE}/pair`, form({ request: requestId!, code: `${realCode.slice(0, 3)} ${realCode.slice(3)}`, action: 'pair' }));
const location = new URL(right.headers.get('location') ?? 'http://x/');
const authCode = location.searchParams.get('code');
check('right code redirects back with a code', right.status === 302 && !!authCode && location.searchParams.get('state') === 'xyzzy', location.href.slice(0, 60));
const replay = await fetch(`${BASE}/pair`, form({ request: requestId!, code: realCode, action: 'pair' }));
check('pairing request is single-use', replay.status === 400);

// 6. Token exchange with PKCE (a wrong verifier first).
const badPkce = await fetch(as.token_endpoint, form({ grant_type: 'authorization_code', code: authCode!, code_verifier: 'nope'.repeat(11), client_id: reg.client_id, redirect_uri: REDIRECT }));
check('wrong PKCE verifier refused', badPkce.status === 400);
const tokRes = await fetch(as.token_endpoint, form({ grant_type: 'authorization_code', code: authCode!, code_verifier: verifier, client_id: reg.client_id, redirect_uri: REDIRECT, resource: MCP }));
const tokens = (await tokRes.json()) as { access_token: string; refresh_token: string; expires_in: number };
check('tokens issued', tokRes.status === 200 && !!tokens.access_token && !!tokens.refresh_token, `expires_in ${tokens.expires_in}`);

// 7. The access token works.
const status = JSON.parse(await callTool(tokens.access_token, 'box_status')) as { connections: Array<{ clientId: string; name: string }> };
check('tool call with the OAuth token', status.connections.some((c) => c.clientId === reg.client_id), `${status.connections.length} connection(s)`);

// 8. Refresh rotates: the new pair works, the old refresh token does not.
const refreshed = (await (await fetch(as.token_endpoint, form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: reg.client_id }))).json()) as {
	access_token: string;
};
check('refresh gives a new access token', !!refreshed.access_token && refreshed.access_token !== tokens.access_token);
const reused = await fetch(as.token_endpoint, form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: reg.client_id }));
check('old refresh token refused', reused.status === 400);

// 9. Revoke, then forget.
await fetch(as.revocation_endpoint, form({ token: refreshed.access_token, client_id: reg.client_id }));
const afterRevoke = await fetch(MCP, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${refreshed.access_token}` }, body: '{}' });
check('revoked token refused', afterRevoke.status === 401);
const forgot = await callTool(TOKEN, 'forget_connection', { clientId: reg.client_id });
check('forget_connection (with the box token)', forgot.startsWith('Forgot'), forgot);
const afterForget = JSON.parse(await callTool(TOKEN, 'box_status')) as { connections: Array<{ clientId: string }>; notices: Array<{ id: string; headline: string }> };
check('connection gone', !afterForget.connections.some((c) => c.clientId === reg.client_id));

// Tidy: the pairing posted a NEW CONNECTION notice.
for (const n of afterForget.notices.filter((x) => x.headline === 'NEW CONNECTION')) await callTool(TOKEN, 'dismiss_notice', { noticeId: n.id });

console.log(failed ? `OAuth smoke failed (${failed})` : 'OAuth smoke passed');
process.exit(failed ? 1 : 0);
