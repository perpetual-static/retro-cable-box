/**
 * Pairing codes: the 6 digits on channel 0 that let a new agent app (claude.ai,
 * the phone app) sign in to the box, like activating a cable box by phone.
 *
 * TOTP-style: HMAC-SHA256(MCP_TOKEN, 10-minute window) → 6 digits. The API
 * (which shows the code) and the MCP server (which checks it) share only the
 * token, so they need no shared state. Node only; not exported from index.ts.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const PAIRING_WINDOW_SEC = 600;

export function pairingCode(secret: string, atMs = Date.now()): string {
	const window = Math.floor(atMs / 1000 / PAIRING_WINDOW_SEC);
	const mac = createHmac('sha256', secret).update(`box-pair:${window}`).digest();
	return String(mac.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

/** Seconds until the code on screen changes. */
export function pairingCodeTtl(atMs = Date.now()): number {
	return PAIRING_WINDOW_SEC - (Math.floor(atMs / 1000) % PAIRING_WINDOW_SEC);
}

/** Accepts the current code and the one before it (someone was slow typing). */
export function checkPairingCode(secret: string, entered: string, atMs = Date.now()): boolean {
	const clean = entered.replace(/\D/g, '');
	if (clean.length !== 6) return false;
	return [atMs, atMs - PAIRING_WINDOW_SEC * 1000].some((t) =>
		timingSafeEqual(Buffer.from(pairingCode(secret, t)), Buffer.from(clean))
	);
}
