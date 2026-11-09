import { describe, expect, it } from 'vitest';
import { checkPairingCode, pairingCode, pairingCodeTtl, PAIRING_WINDOW_SEC } from '../src/pairing';

const T = Date.UTC(2026, 10, 8, 12, 0, 0);

describe('pairing codes', () => {
	it('is 6 digits and the same within a window', () => {
		const c = pairingCode('s', T);
		expect(c).toMatch(/^\d{6}$/);
		expect(pairingCode('s', T + 1000)).toBe(c);
	});
	it('changes with the window and the secret', () => {
		expect(pairingCode('s', T + PAIRING_WINDOW_SEC * 1000)).not.toBe(pairingCode('s', T));
		expect(pairingCode('other', T)).not.toBe(pairingCode('s', T));
	});
	it('accepts the current and the previous code, with spaces', () => {
		const now = T + PAIRING_WINDOW_SEC * 1000;
		const cur = pairingCode('s', now);
		expect(checkPairingCode('s', `${cur.slice(0, 3)} ${cur.slice(3)}`, now)).toBe(true);
		expect(checkPairingCode('s', pairingCode('s', T), now)).toBe(true);
		expect(checkPairingCode('s', pairingCode('s', T - PAIRING_WINDOW_SEC * 1000), now)).toBe(false);
		expect(checkPairingCode('s', '12345', now)).toBe(false);
	});
	it('counts down to the next code', () => {
		expect(pairingCodeTtl(T)).toBe(PAIRING_WINDOW_SEC);
		expect(pairingCodeTtl(T + 1000)).toBe(PAIRING_WINDOW_SEC - 1);
	});
});
