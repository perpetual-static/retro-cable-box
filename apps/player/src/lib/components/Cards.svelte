<script lang="ts">
	/**
	 * Screens that are drawn, not played: the clock, the bulletin board,
	 * "please stand by", and GAME OVER for a channel with nothing to air.
	 */
	import { clockText, dateText, guide, now, type GuideChannel } from '$lib/guide.svelte';

	let {
		kind,
		channel,
		tick,
		countdown = 9
	}: {
		kind: 'clock' | 'notices' | 'standby' | 'empty';
		channel: GuideChannel | null;
		tick: number;
		countdown?: number;
	} = $props();

	const t = $derived.by(() => {
		void tick;
		return now();
	});
	const time = $derived(clockText(t).replace(/\s?[AP]M$/, ''));
	const ampm = $derived(clockText(t).slice(-2));
	const notices = $derived(guide.data?.notices ?? []);
	const ticker = $derived(
		[...notices.map((n) => n.headline.toUpperCase()), 'NO MATTER WHERE YOU GO, THERE YOU ARE.'].join('   ✦   ')
	);
</script>

{#if kind === 'clock'}
	<div class="card clock">
		<div class="station">{channel?.name ?? 'TIME & TEMP'}</div>
		<div class="big">{time}<span class="ampm">{ampm}</span></div>
		<div class="date">{dateText(t)}</div>
		<div class="temp">TEMP <span>--°</span> · ADD A WEATHER KEY TO FILL THIS IN</div>
		<div class="ticker"><span>{ticker}   ✦   {ticker}</span></div>
	</div>
{:else if kind === 'notices'}
	<div class="card notices">
		<h1>{channel?.name ?? 'BULLETIN BOARD'}</h1>
		{#if notices.length === 0}
			<p class="none">NO NEWS IS GOOD NEWS.</p>
		{:else}
			<ul>
				{#each notices.slice(0, 5) as n (n.id)}
					<li class={n.kind}>
						<span class="tag">{n.kind.toUpperCase()}</span>
						<strong>{n.headline}</strong>
						{#if n.body}<p>{n.body}</p>{/if}
					</li>
				{/each}
			</ul>
		{/if}
		<div class="foot">{clockText(t)} · {dateText(t)}</div>
	</div>
{:else if kind === 'standby'}
	<div class="card standby">
		<div class="bars">
			{#each ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'] as color}
				<span style="background: {color}"></span>
			{/each}
		</div>
		<div class="plate">
			<div class="please">PLEASE STAND BY</div>
			<div class="sub">We are experiencing technical difficulties.</div>
		</div>
	</div>
{:else}
	<div class="card empty">
		<div class="over">GAME OVER</div>
		<div class="cont">CONTINUE? <span class="count">{countdown}</span></div>
		<div class="sub">{channel ? `${channel.num} ${channel.name}` : ''} has nothing to air yet.</div>
	</div>
{/if}

<style>
	.card {
		position: absolute;
		inset: 0;
		overflow: hidden;
	}

	/* clock: the local-forecast look */
	.clock {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		background: linear-gradient(180deg, #1c2f9c 0%, #3d2a86 55%, #b4486b 100%);
		font-family: var(--font-osd);
	}
	.station {
		position: absolute;
		top: 6vh;
		left: 6vw;
		font-family: var(--font-head);
		font-size: 4vh;
		letter-spacing: 0.06em;
		color: var(--yellow);
		text-shadow: 0.3vh 0.3vh 0 #000;
	}
	.big {
		font-size: 34vh;
		line-height: 0.85;
		text-shadow: 0.8vh 0.8vh 0 rgba(0, 0, 0, 0.5);
	}
	.ampm {
		font-size: 10vh;
		margin-left: 2vh;
	}
	.date {
		font-size: 7vh;
		letter-spacing: 0.1em;
	}
	.temp {
		margin-top: 3vh;
		font-size: 3.4vh;
		opacity: 0.8;
	}
	.temp span {
		font-size: 5vh;
		color: var(--yellow);
	}
	.ticker {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		padding: 1.4vh 0;
		background: rgba(0, 0, 0, 0.55);
		border-top: 0.3vh solid var(--yellow);
		white-space: nowrap;
		overflow: hidden;
		font-size: 4vh;
	}
	.ticker span {
		display: inline-block;
		padding-left: 100%;
		animation: ticker 40s linear infinite;
	}
	@keyframes ticker {
		to {
			transform: translateX(-100%);
		}
	}

	/* bulletin board */
	.notices {
		background: #0b1150;
		padding: 7vh 8vw;
		display: flex;
		flex-direction: column;
	}
	.notices h1 {
		margin: 0 0 4vh;
		font-family: var(--font-head);
		font-size: 6vh;
		color: var(--yellow);
		letter-spacing: 0.05em;
	}
	.notices ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 2.4vh;
	}
	.notices li {
		border-left: 0.8vh solid #6f8cff;
		padding: 1vh 2vh;
		background: rgba(27, 52, 168, 0.5);
		font-size: 3.4vh;
	}
	.notices li.warning {
		border-color: var(--red);
	}
	.notices li.update {
		border-color: var(--osd);
	}
	.tag {
		font-family: var(--font-osd);
		margin-right: 1.5vh;
		opacity: 0.8;
	}
	.notices p {
		margin: 0.6vh 0 0;
		font-size: 2.8vh;
		opacity: 0.85;
	}
	.none {
		font-family: var(--font-osd);
		font-size: 8vh;
		margin: auto;
	}
	.foot {
		margin-top: auto;
		font-family: var(--font-osd);
		font-size: 3.4vh;
		opacity: 0.7;
	}

	/* please stand by */
	.standby {
		display: grid;
		place-items: center;
		background: #000;
	}
	.bars {
		position: absolute;
		inset: 0;
		display: grid;
		grid-template-columns: repeat(7, 1fr);
	}
	.plate {
		position: relative;
		padding: 3vh 6vw;
		background: #000;
		border: 0.6vh solid var(--white);
		text-align: center;
	}
	.please {
		font-family: var(--font-head);
		font-size: 8vh;
		letter-spacing: 0.04em;
	}
	.standby .sub,
	.empty .sub {
		font-size: 3.2vh;
		opacity: 0.85;
	}

	/* game over */
	.empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2vh;
		background: #000;
		font-family: var(--font-osd);
	}
	.over {
		font-family: var(--font-head);
		font-size: 16vh;
		color: var(--red);
		text-shadow:
			0.8vh 0.8vh 0 #5a0b0b,
			0 0 4vh rgba(255, 59, 59, 0.5);
		letter-spacing: 0.04em;
	}
	.cont {
		font-size: 9vh;
	}
	.count {
		color: var(--yellow);
		display: inline-block;
		min-width: 1ch;
	}

	@media (prefers-reduced-motion: reduce) {
		.ticker span {
			animation: none;
			padding-left: 2vw;
		}
	}
</style>
