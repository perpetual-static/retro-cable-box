<script lang="ts">
	/** The cable-box channel readout: big green numerals, top right. */
	let {
		text,
		label = '',
		visible,
		turbo = false
	}: { text: string; label?: string; visible: boolean; turbo?: boolean } = $props();
</script>

{#if turbo}
	<div class="tunnel" aria-hidden="true">
		{#each Array(14) as _, i}
			<span style="top: {(i * 37) % 100}%; animation-delay: {(i * 53) % 400}ms"></span>
		{/each}
	</div>
{/if}

<div class="osd" class:visible class:turbo aria-live="polite">
	<div class="num">{text}</div>
	{#if label}<div class="label">{label}</div>{/if}
</div>

<style>
	.osd {
		position: absolute;
		top: 5vh;
		right: 5vw;
		text-align: right;
		font-family: var(--font-osd);
		color: var(--osd);
		text-shadow:
			0 0 0.35em var(--osd-glow),
			0.06em 0.06em 0 #000;
		opacity: 0;
		transition: opacity 300ms ease-out;
		z-index: 40;
		pointer-events: none;
	}
	.osd.visible {
		opacity: 1;
		transition: none;
	}
	.num {
		font-size: 11vh;
		line-height: 0.9;
		letter-spacing: 0.04em;
	}
	.label {
		font-size: 4.2vh;
		letter-spacing: 0.08em;
	}
	.osd.turbo .num {
		transform: skewX(-12deg);
		font-size: 14vh;
	}
	.tunnel {
		position: absolute;
		inset: 0;
		z-index: 35;
		pointer-events: none;
		background: radial-gradient(circle at 50% 50%, transparent 30%, rgba(0, 0, 0, 0.6));
	}
	.tunnel span {
		position: absolute;
		left: -40%;
		height: 0.5vh;
		width: 40%;
		background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.85));
		animation: streak 380ms linear infinite;
	}
	@keyframes streak {
		to {
			transform: translateX(350%);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.tunnel span {
			animation: none;
			display: none;
		}
	}
</style>
