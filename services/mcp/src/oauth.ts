/**
 * OAuth for agent apps that sign in (Phase 5), such as claude.ai connectors.
 *
 * claude.ai connectors sign in with OAuth 2.1 (dynamic client registration +
 * PKCE). The SDK's mcpAuthRouter does the protocol work: metadata, /register,
 * /authorize parameter checks, /token with PKCE, /revoke. This file is the
 * provider behind it: where clients and tokens live, and the sign-in page.
 *
 * Sign-in is a pairing code, like activating a cable box: the page asks for
 * the 6 digits on channel 0. The code changes every 10 minutes (pairing.ts).
 * Five wrong codes lock pairing for 10 minutes.
 *
 * Clients and token hashes persist in <BOX_DATA>/oauth.json. Tokens are stored
 * only as SHA-256 hashes. Access tokens last an hour, refresh tokens 90 days
 * (rotated on use).
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import express from 'express';
import type { Response } from 'express';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { checkPairingCode, pairingCodeTtl } from '@box/core/pairing';

const ACCESS_TTL = 60 * 60;
const REFRESH_TTL = 90 * 24 * 60 * 60;
const CODE_TTL = 5 * 60;
const PENDING_TTL = 15 * 60;
const MAX_CLIENTS = 100;
const LOCKOUT_TRIES = 5;
const LOCKOUT_SEC = 10 * 60;

interface TokenRecord {
	kind: 'access' | 'refresh';
	clientId: string;
	scopes: string[];
	expiresAt: number;
	resource?: string;
}

interface StoreFile {
	clients: Record<string, OAuthClientInformationFull & { pairedAt?: number }>;
	tokens: Record<string, TokenRecord>;
}

interface Pending {
	clientId: string;
	params: AuthorizationParams;
	expiresAt: number;
}

interface IssuedCode {
	clientId: string;
	params: AuthorizationParams;
	expiresAt: number;
}

const now = (): number => Math.floor(Date.now() / 1000);
const hash = (token: string): string => createHash('sha256').update(token).digest('hex');
const newSecret = (): string => randomBytes(32).toString('base64url');

export class BoxOAuthProvider implements OAuthServerProvider {
	private store: StoreFile = { clients: {}, tokens: {} };
	private pending = new Map<string, Pending>();
	private codes = new Map<string, IssuedCode>();
	private failures: number[] = [];

	constructor(
		private readonly file: string,
		private readonly secret: string,
		private readonly onPaired: (clientName: string) => void = () => {}
	) {
		try {
			this.store = JSON.parse(readFileSync(file, 'utf8')) as StoreFile;
		} catch {
			// first run: empty store
		}
		this.prune();
	}

	get clientsStore(): OAuthRegisteredClientsStore {
		return {
			getClient: (clientId) => this.store.clients[clientId],
			registerClient: (client) => {
				// The SDK fills in client_id before it calls this.
				const full = client as OAuthClientInformationFull;
				this.store.clients[full.client_id] = full;
				this.trimClients();
				this.save();
				return full;
			}
		};
	}

	/** Shows the pairing page. The pairing form posts to /pair (pairRouter). */
	async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
		this.sweep();
		const id = newSecret();
		this.pending.set(id, { clientId: client.client_id, params, expiresAt: now() + PENDING_TTL });
		res.status(200).type('html').send(pairPage(id, client.client_name ?? 'An agent app'));
	}

	async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
		const issued = this.codes.get(code);
		if (!issued || issued.clientId !== client.client_id || issued.expiresAt < now()) {
			throw new InvalidGrantError('Unknown or expired authorization code');
		}
		return issued.params.codeChallenge;
	}

	async exchangeAuthorizationCode(
		client: OAuthClientInformationFull,
		code: string,
		_codeVerifier?: string,
		redirectUri?: string
	): Promise<OAuthTokens> {
		const issued = this.codes.get(code);
		this.codes.delete(code); // one use only
		if (!issued || issued.clientId !== client.client_id || issued.expiresAt < now()) {
			throw new InvalidGrantError('Unknown or expired authorization code');
		}
		if (redirectUri && redirectUri !== issued.params.redirectUri) {
			throw new InvalidGrantError('redirect_uri does not match the authorization request');
		}
		return this.issue(client.client_id, issued.params.scopes ?? [], issued.params.resource?.href);
	}

	async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]): Promise<OAuthTokens> {
		const key = hash(refreshToken);
		const rec = this.store.tokens[key];
		if (!rec || rec.kind !== 'refresh' || rec.clientId !== client.client_id || rec.expiresAt < now()) {
			throw new InvalidGrantError('Unknown or expired refresh token');
		}
		delete this.store.tokens[key]; // rotate
		return this.issue(client.client_id, scopes?.length ? scopes : rec.scopes, rec.resource);
	}

	async verifyAccessToken(token: string): Promise<AuthInfo> {
		const rec = this.store.tokens[hash(token)];
		if (!rec || rec.kind !== 'access' || rec.expiresAt < now()) throw new InvalidTokenError('Unknown or expired token');
		if (!this.store.clients[rec.clientId]) throw new InvalidTokenError('Client was removed');
		return {
			token,
			clientId: rec.clientId,
			scopes: rec.scopes,
			expiresAt: rec.expiresAt,
			resource: rec.resource ? new URL(rec.resource) : undefined
		};
	}

	async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
		const key = hash(request.token);
		if (this.store.tokens[key]?.clientId === client.client_id) {
			delete this.store.tokens[key];
			this.save();
		}
	}

	/** Paired clients, for box_status and the forget tool. */
	paired(): Array<{ clientId: string; name: string; pairedAt: number }> {
		return Object.values(this.store.clients)
			.filter((c) => c.pairedAt)
			.map((c) => ({ clientId: c.client_id, name: c.client_name ?? 'An agent app', pairedAt: c.pairedAt! }));
	}

	/** Removes a client and every token it holds. */
	forget(clientId: string): boolean {
		if (!this.store.clients[clientId]) return false;
		delete this.store.clients[clientId];
		for (const [k, t] of Object.entries(this.store.tokens)) if (t.clientId === clientId) delete this.store.tokens[k];
		this.save();
		return true;
	}

	/** POST /pair: the form on the pairing page. */
	pairRouter(): express.Router {
		const router = express.Router();
		router.post('/pair', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
			this.sweep();
			const id = String(req.body?.request ?? '');
			const pending = this.pending.get(id);
			if (!pending) {
				res.status(400).type('html').send(messagePage('This sign-in page expired. Go back to your agent app and connect again.'));
				return;
			}
			const client = this.store.clients[pending.clientId];
			const name = client?.client_name ?? 'An agent app';
			const back = (params: Record<string, string>): void => {
				this.pending.delete(id);
				const url = new URL(pending.params.redirectUri);
				for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
				if (pending.params.state) url.searchParams.set('state', pending.params.state);
				res.redirect(302, url.href);
			};

			if (req.body?.action === 'cancel') return back({ error: 'access_denied', error_description: 'Pairing cancelled' });

			const t = now();
			this.failures = this.failures.filter((f) => f > t - LOCKOUT_SEC);
			if (this.failures.length >= LOCKOUT_TRIES) {
				res.status(429).type('html').send(pairPage(id, name, 'Too many wrong codes. Wait 10 minutes, then try again.'));
				return;
			}
			if (!client || !checkPairingCode(this.secret, String(req.body?.code ?? ''))) {
				this.failures.push(t);
				const left = LOCKOUT_TRIES - this.failures.length;
				res.status(401).type('html').send(pairPage(id, name, `That is not the code on channel 0. ${left} ${left === 1 ? 'try' : 'tries'} left.`));
				return;
			}

			const code = newSecret();
			this.codes.set(code, { clientId: pending.clientId, params: pending.params, expiresAt: t + CODE_TTL });
			client.pairedAt = t;
			this.save();
			this.onPaired(name);
			back({ code });
		});
		return router;
	}

	private issue(clientId: string, scopes: string[], resource?: string): OAuthTokens {
		const access = newSecret();
		const refresh = newSecret();
		const t = now();
		this.store.tokens[hash(access)] = { kind: 'access', clientId, scopes, expiresAt: t + ACCESS_TTL, resource };
		this.store.tokens[hash(refresh)] = { kind: 'refresh', clientId, scopes, expiresAt: t + REFRESH_TTL, resource };
		this.prune();
		this.save();
		return {
			access_token: access,
			token_type: 'bearer',
			expires_in: ACCESS_TTL,
			refresh_token: refresh,
			scope: scopes.join(' ') || undefined
		};
	}

	/** Drops expired codes and pending sign-ins (memory only). */
	private sweep(): void {
		const t = now();
		for (const [k, v] of this.pending) if (v.expiresAt < t) this.pending.delete(k);
		for (const [k, v] of this.codes) if (v.expiresAt < t) this.codes.delete(k);
	}

	/** Drops expired tokens. */
	private prune(): void {
		const t = now();
		for (const [k, v] of Object.entries(this.store.tokens)) if (v.expiresAt < t) delete this.store.tokens[k];
	}

	/** Registration is open to anyone, so cap it: drop the oldest never-paired clients. */
	private trimClients(): void {
		const unpaired = Object.values(this.store.clients)
			.filter((c) => !c.pairedAt)
			.sort((a, b) => (a.client_id_issued_at ?? 0) - (b.client_id_issued_at ?? 0));
		let extra = Object.keys(this.store.clients).length - MAX_CLIENTS;
		for (const c of unpaired) {
			if (extra-- <= 0) break;
			delete this.store.clients[c.client_id];
		}
	}

	private save(): void {
		mkdirSync(dirname(this.file), { recursive: true });
		const tmp = `${this.file}.tmp`;
		writeFileSync(tmp, JSON.stringify(this.store, null, 1), { mode: 0o600 });
		renameSync(tmp, this.file);
	}
}

// ── Pages ────────────────────────────────────────────────────────────────────

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const shell = (body: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Retro Cable Box · Pair</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=VT323&display=swap" rel="stylesheet">
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box;
    background: repeating-linear-gradient(45deg, #0b1150 0 16px, #0d1460 16px 32px); color: #f4f1e0;
    font-family: VT323, ui-monospace, monospace; font-size: 22px; }
  .panel { width: min(520px, 100%); background: #10195e; border: 4px solid #6f8cff; padding: 24px; box-sizing: border-box; }
  h1 { margin: 0 0 12px; font-size: 32px; color: #ffe066; letter-spacing: 1px; }
  p { margin: 0 0 16px; line-height: 1.15; }
  input { width: 100%; box-sizing: border-box; font: inherit; font-size: 48px; letter-spacing: 12px; text-align: center;
    background: #000; color: #7dff7a; border: 3px solid #6f8cff; padding: 8px; }
  .row { display: flex; gap: 12px; margin-top: 16px; }
  button { flex: 1; font: inherit; font-size: 24px; padding: 10px; border: 3px solid #f4f1e0; cursor: pointer; }
  .go { background: #ffe066; color: #10195e; }
  .no { background: transparent; color: #f4f1e0; }
  .err { color: #ff8080; }
  .dim { color: #9aa6e8; font-size: 18px; }
</style></head><body><div class="panel">${body}</div></body></html>`;

function pairPage(requestId: string, clientName: string, error?: string): string {
	return shell(`
  <h1>PAIR WITH THIS BOX</h1>
  <p><b>${esc(clientName)}</b> wants to program your Retro Cable Box.</p>
  <p>Tune the TV to <b>channel 0</b> and type the 6-digit code you see.</p>
  ${error ? `<p class="err">${esc(error)}</p>` : ''}
  <form method="post" action="/pair">
    <input type="hidden" name="request" value="${esc(requestId)}">
    <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="7" placeholder="000000" autofocus required>
    <div class="row">
      <button class="go" name="action" value="pair" type="submit">PAIR</button>
      <button class="no" name="action" value="cancel" type="submit" formnovalidate>CANCEL</button>
    </div>
  </form>
  <p class="dim" style="margin-top:16px">The code changes every 10 minutes (next change in ${Math.ceil(pairingCodeTtl() / 60)} min).</p>`);
}

function messagePage(message: string): string {
	return shell(`<h1>RETRO CABLE BOX</h1><p>${esc(message)}</p>`);
}
