/**
 * Worker smoke test against a running worker + Temporal:
 * query → valid update → rejected update → cleanup, on a throwaway channel.
 *   pnpm --filter @box/worker smoke
 */

import { channelHandle, createChannel, queryChannel, removeChannel, unwrapError } from '@box/core/client';
import { addItems, getSchedule, removeItem } from '@box/core/workflows';
import { whatsOn } from '@box/core/schedule';

const ID = 'worker-smoke';

async function main(): Promise<void> {
	await removeChannel(ID).catch(() => undefined);
	await createChannel({ id: ID, num: 991, name: 'WORKER SMOKE', kind: 'playlist', anchorEpoch: Math.floor(Date.now() / 1000), items: [] });
	const h = await channelHandle(ID);

	const item = (id: string) => ({ id, title: id, durationSec: 60, source: { kind: 'url' as const, url: `https://example.com/${id}.mp4` } });
	const after = await h.executeUpdate(addItems, { args: [{ items: [item('one'), item('two')] }] });
	console.log('✓ addItems →', after.items.length, 'items');

	const flat = await h.query(getSchedule);
	console.log('✓ getSchedule → loop', flat.totalSec, 's · on now:', whatsOn(flat, Date.now() / 1000)?.item.title);

	try {
		await h.executeUpdate(addItems, { args: [{ items: [item('one')] }] });
		throw new Error('duplicate item was accepted');
	} catch (err) {
		const msg = unwrapError(err);
		if (msg.includes('accepted')) throw err;
		console.log('✓ duplicate rejected →', msg);
	}

	await h.executeUpdate(removeItem, { args: [{ itemId: 'one' }] });
	console.log('✓ removeItem →', (await queryChannel(ID)).items.length, 'item left');

	await removeChannel(ID);
	console.log('\nWorker smoke passed');
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error('✗ worker smoke failed:', err);
		process.exit(1);
	});
