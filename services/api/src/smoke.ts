/** API smoke test. Needs the stack running. */
const base = process.env.API_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 8760}`;

async function main(): Promise<void> {
	const res = await fetch(`${base}/api/guide`);
	if (!res.ok) throw new Error(`/api/guide ${res.status}`);
	const g = (await res.json()) as { channels: { id: string; num: number; name: string }[]; schedules: Record<string, { totalSec: number; items: unknown[] }> };
	const playable = g.channels.filter((c) => (g.schedules[c.id]?.totalSec ?? 0) > 0);
	console.log(`✓ /api/guide — ${g.channels.length} channels, ${playable.length} with something to air`);
	for (const c of g.channels) console.log(`   ${String(c.num).padStart(3)} ${c.name.padEnd(18)} ${g.schedules[c.id].items.length} items`);
	if (g.channels.length === 0) throw new Error('no channels');
	console.log('\nAPI smoke passed');
}

main().catch((err) => {
	console.error('✗ API smoke failed:', err.message);
	process.exit(1);
});
