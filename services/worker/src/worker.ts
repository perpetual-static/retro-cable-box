/**
 * box-worker — hosts the channel, lineup and ingest workflows.
 *
 * On boot it (1) upserts its Temporal namespace, (2) starts the lineup
 * workflow if needed and, on a fresh box, imports the starter lineup, then
 * (3) polls the task queue. Workflow code is bundled from @box/core by
 * Temporal's loader, so there is no separate build step in development.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Long from 'long';
import { NativeConnection, Worker } from '@temporalio/worker';
import { ensureLineup, getClient, importLineup, TASK_QUEUE, temporalConfig } from '@box/core/client';
import { HEALTHCHECK_SCHEDULE_ID } from '@box/core/workflows';
import type { LineupFile } from '@box/core/types';
import { activities } from './activities';

const require = createRequire(import.meta.url);
const BUNDLE = resolve(import.meta.dirname, '../dist/workflow-bundle.js');
const log = (...args: unknown[]) => console.log('[box-worker]', ...args);

async function ensureNamespace(namespace: string): Promise<void> {
	const svc = (await getClient()).connection.workflowService;
	try {
		await svc.describeNamespace({ namespace });
		return;
	} catch {
		// not found → register
	}
	try {
		await svc.registerNamespace({
			namespace,
			workflowExecutionRetentionPeriod: { seconds: Long.fromNumber(7 * 24 * 60 * 60) }
		});
		log(`registered Temporal namespace "${namespace}"`);
	} catch (err) {
		console.warn(`[box-worker] ensureNamespace: ${(err as Error).message}`);
	}
	// A new namespace takes a few seconds to become usable for workflow calls.
	for (let i = 0; i < 60; i += 1) {
		try {
			await svc.listWorkflowExecutions({ namespace, pageSize: 1 });
			return;
		} catch {
			await new Promise((r) => setTimeout(r, 500));
		}
	}
}

/** First boot: start the lineup and import the starter channels. */
async function seed(): Promise<void> {
	const created = await ensureLineup();
	if (!created) return;
	const path = process.env.SEED_LINEUP ?? resolve(import.meta.dirname, '../../../lineups/starter.json');
	try {
		const file = JSON.parse(await readFile(path, 'utf8')) as LineupFile;
		const report = await importLineup(file);
		log(`fresh box: imported "${file.name}" → ${report.created.length} channels, ingesting ${report.ingesting.length}`);
		for (const s of report.skipped) log(`  skipped ${s.id}: ${s.reason}`);
	} catch (err) {
		log(`no starter lineup imported (${(err as Error).message})`);
	}
}

/** The nightly health check, as a Temporal Schedule (3:30 am box time). Idempotent. */
async function ensureSchedules(): Promise<void> {
	const client = await getClient();
	try {
		await client.schedule.create({
			scheduleId: HEALTHCHECK_SCHEDULE_ID,
			spec: { calendars: [{ hour: 3, minute: 30 }], timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone },
			action: { type: 'startWorkflow', workflowType: 'healthcheckWorkflow', taskQueue: TASK_QUEUE, args: [] },
			policies: { overlap: 'SKIP' }
		});
		log('scheduled the nightly health check (3:30 am)');
	} catch (err) {
		if (!/already/i.test((err as Error).message)) log(`schedule: ${(err as Error).message}`);
	}
}

async function run(): Promise<void> {
	await ensureNamespace(temporalConfig.namespace);

	const connection = await NativeConnection.connect({ address: temporalConfig.address });
	const worker = await Worker.create({
		connection,
		namespace: temporalConfig.namespace,
		taskQueue: TASK_QUEUE,
		// Production uses the pre-built bundle (`pnpm --filter @box/worker build`);
		// development bundles on start so edits hot-reload.
		...(existsSync(BUNDLE) && process.env.NODE_ENV === 'production'
			? { workflowBundle: { codePath: BUNDLE } }
			: { workflowsPath: require.resolve('@box/core/workflows') }),
		activities
	});

	log(`polling ${temporalConfig.address} ns=${temporalConfig.namespace} queue=${TASK_QUEUE}`);
	// Seed once the worker is polling, so the import's ingest workflows run.
	const running = worker.run();
	await seed();
	await ensureSchedules();
	await running;
}

run().catch((err) => {
	console.error('[box-worker] fatal:', err);
	process.exit(1);
});
