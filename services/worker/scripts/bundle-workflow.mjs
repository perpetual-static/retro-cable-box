// Build step: pre-bundle the workflow code so the worker does not run webpack
// at every start (slow and memory-hungry on a Pi). Writes dist/workflow-bundle.js.
import { bundleWorkflowCode } from '@temporalio/worker';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { code } = await bundleWorkflowCode({ workflowsPath: require.resolve('@box/core/workflows') });
mkdirSync('dist', { recursive: true });
writeFileSync('dist/workflow-bundle.js', code);
console.log(`workflow bundle written: ${(code.length / 1024).toFixed(0)} KiB`);
