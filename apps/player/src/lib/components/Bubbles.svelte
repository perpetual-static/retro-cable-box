<script lang="ts">
	/**
	 * Pop-up trivia bubbles over the video. Shown while the item's playhead is
	 * inside a bubble's window; each pops in with a bloop.
	 */
	import type { Bubble } from '@box/core/types';
	import { bloop } from '$lib/sound';

	let { bubbles, position, enabled }: { bubbles: Bubble[]; position: number; enabled: boolean } = $props();

	const SPOTS = [
		{ top: '10%', left: '8%' },
		{ top: '14%', right: '9%' },
		{ bottom: '24%', left: '10%' },
		{ bottom: '20%', right: '8%' },
		{ top: '38%', left: '14%' },
		{ top: '30%', right: '14%' }
	];

	const showing = $derived(
		enabled ? bubbles.filter((b) => position >= b.atSec && position < b.atSec + (b.durationSec ?? 6)) : []
	);

	let seen = new Set<string>();
	$effect(() => {
		for (const b of showing) {
			const key = `${b.atSec}:${b.text}`;
			if (!seen.has(key)) {
				seen.add(key);
				bloop();
			}
		}
		if (seen.size > 200) seen = new Set();
	});

	const spot = (b: Bubble) => {
		const s = SPOTS[Math.abs(Math.floor(b.atSec * 7 + b.text.length)) % SPOTS.length];
		return Object.entries(s)
			.map(([k, v]) => `${k}: ${v}`)
			.join('; ');
	};
	const tailLeft = (b: Bubble) => !('right' in SPOTS[Math.abs(Math.floor(b.atSec * 7 + b.text.length)) % SPOTS.length]);
</script>

{#each showing as b (b.atSec + b.text)}
	<div class="bubble" class:tail-left={tailLeft(b)} style={spot(b)}>
		{b.text}
	</div>
{/each}

<style>
	.bubble {
		position: absolute;
		max-width: 34vw;
		padding: 1.6vh 2.2vh;
		background: #fffef6;
		color: #111;
		border: 0.35vh solid #111;
		border-radius: 3vh;
		font-family: var(--font-body);
		font-weight: 700;
		font-size: 3.2vh;
		line-height: 1.15;
		box-shadow: 0.6vh 0.6vh 0 rgba(0, 0, 0, 0.55);
		animation: pop 260ms cubic-bezier(0.2, 1.6, 0.4, 1) both;
		z-index: 25;
		pointer-events: none;
	}
	.bubble::after {
		content: '';
		position: absolute;
		bottom: -2.2vh;
		right: 4vh;
		border-width: 2.2vh 1.6vh 0 1.6vh;
		border-style: solid;
		border-color: #111 transparent transparent transparent;
	}
	.bubble.tail-left::after {
		right: auto;
		left: 4vh;
	}
	@keyframes pop {
		from {
			transform: scale(0.2);
			opacity: 0;
		}
		to {
			transform: scale(1);
			opacity: 1;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.bubble {
			animation: none;
		}
	}
</style>
