<script lang="ts">
	/** Bottom info bar shown on tune and on INFO: what's on, how far in, what's next. */
	import { isLiveGap, type Airing } from '@box/core';
	import { clockText, now, type GuideChannel } from '$lib/guide.svelte';

	let {
		channel,
		airing,
		next,
		visible,
		tick
	}: { channel: GuideChannel | null; airing: Airing | null; next: string | null; visible: boolean; tick: number } = $props();

	/** A live channel with no guide data for now: show LIVE, not a time range. */
	const gap = $derived(!!airing && isLiveGap(airing));
	const liveText = (blurb?: string): string => {
		const t = blurb?.replace(/^Live:\s*/i, '').trim();
		return t ? t[0].toUpperCase() + t.slice(1) : 'Live TV';
	};

	const progress = $derived.by(() => {
		void tick;
		if (!airing) return 0;
		return Math.min(1, Math.max(0, (now() - airing.startsAt) / airing.item.durationSec));
	});
</script>

{#if channel}
	<div class="banner" class:visible>
		<div class="num">{channel.num}</div>
		<div class="body">
			<div class="row top">
				<span class="name">{channel.name}</span>
				{#if gap}
					<span class="time live">● LIVE</span>
				{:else if airing}
					<span class="time">{clockText(airing.startsAt)} – {clockText(airing.endsAt)}</span>
				{/if}
			</div>
			<div class="title">
				{#if gap}
					{liveText(channel.blurb)}
				{:else if airing}
					{airing.item.title}{#if airing.item.year}<span class="year">&nbsp;({airing.item.year})</span>{/if}
				{:else if channel.kind === 'card'}
					{channel.blurb ?? channel.name}
				{:else}
					Nothing scheduled
				{/if}
			</div>
			{#if airing && !gap}
				<div class="bar"><div class="fill" style="width: {progress * 100}%"></div></div>
			{/if}
			{#if next}<div class="next">NEXT: {next}</div>{/if}
		</div>
	</div>
{/if}

<style>
	.time.live {
		color: #ff5a5a;
	}
	.banner {
		position: absolute;
		left: 5vw;
		right: 5vw;
		bottom: 6vh;
		display: flex;
		align-items: stretch;
		gap: 0;
		background: linear-gradient(180deg, rgba(14, 28, 120, 0.94), rgba(6, 12, 60, 0.94));
		border: 0.3vh solid #6f8cff;
		box-shadow: 0 1vh 3vh rgba(0, 0, 0, 0.6);
		transform: translateY(4vh);
		opacity: 0;
		transition:
			opacity 250ms ease-out,
			transform 250ms ease-out;
		z-index: 38;
		pointer-events: none;
	}
	.banner.visible {
		opacity: 1;
		transform: none;
	}
	.num {
		display: grid;
		place-items: center;
		min-width: 13vh;
		padding: 0 2vh;
		background: var(--yellow);
		color: #101010;
		font-family: var(--font-head);
		font-size: 7vh;
	}
	.body {
		flex: 1;
		padding: 1.6vh 2.4vh;
		min-width: 0;
	}
	.row {
		display: flex;
		justify-content: space-between;
		gap: 2vh;
	}
	.name {
		font-family: var(--font-head);
		font-size: 2.6vh;
		letter-spacing: 0.06em;
		color: var(--yellow);
	}
	.time {
		font-family: var(--font-osd);
		font-size: 3.2vh;
	}
	.title {
		font-family: var(--font-body);
		font-weight: 700;
		font-size: 4.4vh;
		line-height: 1.1;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.year {
		font-weight: 500;
		opacity: 0.75;
	}
	.bar {
		margin-top: 1vh;
		height: 0.8vh;
		background: rgba(255, 255, 255, 0.18);
	}
	.fill {
		height: 100%;
		background: var(--osd);
	}
	.next {
		margin-top: 0.8vh;
		font-size: 2.6vh;
		opacity: 0.85;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
