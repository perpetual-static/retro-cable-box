<script lang="ts">
	/**
	 * Channel 1992. Letter tiles spell one phrase, scramble, and settle into its
	 * anagram, the way the tiles do in the film. Calls `done` when finished.
	 */
	let { done }: { done: () => void } = $props();

	const FROM = 'SETEC ASTRONOMY';
	const TO = 'TOO MANY SECRETS';
	const TILE = 5.4; // vw per slot

	interface Tile {
		letter: string;
		from: number;
		to: number;
		jx: number;
		jy: number;
		rot: number;
	}

	const slots = (s: string) => [...s].map((ch, i) => ({ ch, i })).filter((x) => x.ch !== ' ');
	const centered = (i: number, len: number) => (i - (len - 1) / 2) * TILE;

	const tiles: Tile[] = (() => {
		const src = slots(FROM);
		const dst = slots(TO);
		const used = new Set<number>();
		return dst.map((d) => {
			const k = src.findIndex((s, idx) => s.ch === d.ch && !used.has(idx));
			used.add(k);
			return {
				letter: d.ch,
				from: centered(src[k].i, FROM.length),
				to: centered(d.i, TO.length),
				jx: (Math.random() - 0.5) * 70,
				jy: (Math.random() - 0.5) * 40,
				rot: (Math.random() - 0.5) * 50
			};
		});
	})();

	const POINTS: Record<string, number> = { S: 1, E: 1, T: 1, C: 3, A: 1, R: 1, O: 1, N: 1, M: 3, Y: 4 };

	let phase = $state<'from' | 'scramble' | 'to' | 'out'>('from');

	$effect(() => {
		const timers = [
			setTimeout(() => (phase = 'scramble'), 1800),
			setTimeout(() => (phase = 'to'), 3200),
			setTimeout(() => (phase = 'out'), 7600),
			setTimeout(() => done(), 8400)
		];
		return () => timers.forEach(clearTimeout);
	});

	const place = (t: Tile, i: number) => {
		if (phase === 'from') return `transform: translate(${t.from}vw, 0) rotate(0deg)`;
		if (phase === 'scramble') return `transform: translate(${t.jx}vw, ${t.jy}vh) rotate(${t.rot}deg)`;
		return `transform: translate(${t.to}vw, 0) rotate(0deg); transition-delay: ${i * 70}ms`;
	};
</script>

<div class="setec" class:out={phase === 'out'} role="img" aria-label="Setec Astronomy becomes Too Many Secrets">
	{#each tiles as t, i}
		<div class="tile" style={place(t, i)}>
			{t.letter}<sub>{POINTS[t.letter] ?? 1}</sub>
		</div>
	{/each}
</div>

<style>
	.setec {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		background: radial-gradient(circle, #3b2614 0%, #120a04 80%);
		z-index: 45;
		transition: opacity 700ms ease-in;
	}
	.setec.out {
		opacity: 0;
	}
	.tile {
		position: absolute;
		width: 4.9vw;
		height: 4.9vw;
		display: grid;
		place-items: center;
		background: linear-gradient(160deg, #f6e6c0, #dcc392);
		color: #1b1208;
		border-radius: 0.5vw;
		box-shadow:
			0 0.5vw 0 #a8875a,
			0 0.9vw 1.4vw rgba(0, 0, 0, 0.6);
		font-family: var(--font-head);
		font-size: 3vw;
		transition: transform 1100ms cubic-bezier(0.3, 1.2, 0.4, 1);
	}
	sub {
		position: absolute;
		right: 0.5vw;
		bottom: 0.3vw;
		font-size: 1.1vw;
		font-family: var(--font-body);
	}
</style>
