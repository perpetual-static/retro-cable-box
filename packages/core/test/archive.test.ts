import { describe, expect, it } from 'vitest';
import { stem } from '../src/archive';

describe('stem', () => {
	it('groups copies of one program under one name', () => {
		for (const f of ['Tomorrow1941.mp4', 'Tomorrow1941_256kb.mp4', 'Tomorrow1941_512kb.mp4', 'Tomorrow1941_64kb.mp4', 'Tomorrow1941.ia.mp4', 'Tomorrow1941_edit.mp4']) {
			expect(stem(f)).toBe('tomorrow1941');
		}
	});
	it('keeps different programs apart', () => {
		expect(stem('VTS_01_1_512Kb.mp4')).toBe('vts_01_1');
		expect(stem('VTS_01_2.mp4')).not.toBe(stem('VTS_01_1.mp4'));
	});
});
