<script lang="ts">
	/**
	 * The channel guide, in the spirit of the 90s cable preview channels: the
	 * live picture shrinks into the top-left window, details top right, and a
	 * blue grid of now / next / later underneath.
	 *
	 * `page` moves the grid forward in 30-minute steps (← →, or a sideways
	 * swipe) to look at the schedule ahead; tuning always tunes to now.
	 * Clicking (or tapping) a row selects it; clicking the selected row tunes.
	 */
	import { channelAirings, clockText, dateText, guide, now, onAir, type GuideChannel } from '$lib/guide.svelte';

	let {
		open,
		selected,
		tick,
		page = 0,
		onpick
	}: { open: boolean; selected: string | null; tick: number; page?: number; onpick?: (id: string) => void } = $props();

	// A phone held upright gets a 1-hour window (wider cells) and more rows.
	let portrait = $state(false);
	$effect(() => {
		const mq = window.matchMedia('(orientation: portrait)');
		portrait = mq.matches;
		const on = (e: MediaQueryListEvent): void => void (portrait = e.matches);
		mq.addEventListener('change', on);
		return () => mq.removeEventListener('change', on);
	});
	const SLOTS = $derived(portrait ? 2 : 3);
	const WINDOW = $derived(SLOTS * 1800);
	// Portrait: as many rows as fit between the time row and the footer.
	// Measured in pixels: on a phone, CSS vh is the height with the browser bars
	// hidden, so it is larger than the visible screen.
	let rowsH = $state(0);
	let rowH = $state(0);
	const ROW_GAP = 0.1; // the 0.5vh gap is about a tenth of a row
	const ROWS_VISIBLE = $derived.by(() => {
		if (!portrait) return 6;
		if (!rowsH || !rowH) return 5;
		return Math.max(2, Math.floor((rowsH + rowH * ROW_GAP) / (rowH * (1 + ROW_GAP))));
	});

	const start = $derived.by(() => {
		void tick;
		return Math.floor(now() / 1800) * 1800 + page * 1800;
	});
	/** Where "now" falls in the window, 0–100 %, or null when looking ahead. */
	const nowLine = $derived.by(() => {
		void tick;
		const p = ((now() - start) / WINDOW) * 100;
		return p >= 0 && p <= 100 ? p : null;
	});
	// The guide stays mounted while hidden, so the clock must follow the tick.
	const clock = $derived.by(() => {
		void tick;
		return clockText(now());
	});
	const date = $derived.by(() => {
		void tick;
		return dateText(now());
	});
	const slots = $derived(Array.from({ length: SLOTS }, (_, i) => start + i * 1800));

	const channels = $derived(guide.data?.channels ?? []);
	const selIndex = $derived(Math.max(0, channels.findIndex((c) => c.id === selected)));
	const firstRow = $derived(Math.min(Math.max(0, selIndex - 2), Math.max(0, channels.length - ROWS_VISIBLE)));
	const rows = $derived(channels.slice(firstRow, firstRow + ROWS_VISIBLE));
	const sel = $derived(channels[selIndex]);

	interface Cell {
		title: string;
		left: number;
		width: number;
		before: boolean;
		after: boolean;
	}

	function cells(c: GuideChannel): Cell[] {
		const end = start + WINDOW;
		if (c.kind === 'card') {
			return [{ title: c.blurb ?? c.name, left: 0, width: 100, before: true, after: true }];
		}
		const list = onAir(c) ? channelAirings(c, start, end, 40) : [];
		if (!list.length) {
			return [{ title: 'Off the air', left: 0, width: 100, before: false, after: false }];
		}
		return list.map((a) => {
			const s = Math.max(a.startsAt, start);
			const e = Math.min(a.endsAt, end);
			return {
				title: a.item.title,
				left: ((s - start) / WINDOW) * 100,
				width: ((e - s) / WINDOW) * 100,
				before: a.startsAt < start,
				after: a.endsAt > end
			};
		});
	}

	/** On now plus what comes next on the selected channel: full titles, not cut to fit a grid cell. */
	const selUp = $derived.by(() => {
		void tick;
		if (!sel || sel.kind === 'card') return null;
		const list = channelAirings(sel, page === 0 ? now() : start, Infinity, 5);
		return list.length ? list : null;
	});

</script>

<div class="guide" class:open aria-hidden={!open}>
	<header>
		<div class="window"></div>
		<div class="details">
			<div class="brand">
				<span class="box">{guide.data?.boxName ?? 'RETRO CABLE'}</span>
				<span class="clock">{clock}</span>
			</div>
			<div class="date">{date}</div>
			{#if sel}
				<div class="sel">
					<div class="sel-head">
						<span class="sel-num">{sel.num}</span>{sel.name}
						{#if page > 0}<span class="ahead">AT {clockText(start)}</span>{/if}
					</div>
					{#if selUp}
						<div class="sel-title">{selUp[0].item.title}</div>
						<div class="sel-time">{clockText(selUp[0].startsAt)} – {clockText(selUp[0].endsAt)}</div>
						{#if selUp.length > 1}
							<ol class="later">
								{#each selUp.slice(1, 4) as a (a.startsAt)}
									<li><span class="at">{clockText(a.startsAt)}</span><span class="lt">{a.item.title}</span></li>
								{/each}
							</ol>
						{:else if sel.blurb}
							<div class="blurb">{sel.blurb}</div>
						{/if}
					{:else if sel.blurb}
						<div class="blurb">{sel.blurb}</div>
					{/if}
				</div>
			{/if}
		</div>
	</header>

	<section class="grid">
		<div class="row times" bind:clientHeight={rowH}>
			<div class="ch"><span class="arrow">{page > 0 ? '◀' : ''}▲▼▶</span> CH</div>
			<div class="track">
				{#each slots as t, i}
					<div class="slot" style="left: {(i / SLOTS) * 100}%">{clockText(t)}</div>
				{/each}
			</div>
		</div>
		<div class="rows" bind:clientHeight={rowsH}>
		{#each rows as c (c.id)}
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<div class="row" class:selected={c.id === sel?.id} role="button" tabindex="-1" onclick={() => onpick?.(c.id)}>
				<div class="ch">
					<span class="n">{c.num}</span>
					<span class="nm">{c.name}</span>
				</div>
				<div class="track">
					{#if nowLine !== null}<div class="now-line" style="left: {nowLine}%"></div>{/if}
					{#each cells(c) as cell}
						<div class="cell" style="left: {cell.left}%; width: {cell.width}%">
							{#if cell.width < 3.5}
								<!-- too narrow to label -->
							{:else}
							{#if cell.before}<span class="cont">◀</span>{/if}
							<span class="t">{cell.title}</span>
							{#if cell.after}<span class="cont">▶</span>{/if}
							{/if}
						</div>
					{/each}
				</div>
			</div>
		{/each}
		</div>
		<footer class="keys">↑↓ SELECT · ←→ TIME · OK TUNE · G CLOSE · CLICK A ROW, CLICK AGAIN TO TUNE</footer>
		<footer class="touch">SWIPE ↑↓ SELECT · ←→ TIME · TAP A ROW, TAP AGAIN TO TUNE · HOLD CLOSE</footer>
	</section>

</div>

<style>
	.guide {
		position: absolute;
		inset: 0;
		display: grid;
		grid-template-rows: 46% 54%;
		background: var(--navy);
		opacity: 0;
		pointer-events: none;
		transition: opacity 200ms ease-out;
		z-index: 20;
	}
	.guide.open {
		opacity: 1;
		pointer-events: auto;
	}
	header {
		display: grid;
		grid-template-columns: 1fr 1fr;
		padding: 3vh 4vw 1.5vh;
		gap: 2.5vw;
		background: linear-gradient(180deg, #0d1866, var(--navy));
	}
	/* The live video is positioned over this window by the page. */
	.window {
		border: 0.4vh solid #6f8cff;
		box-shadow: 0 0 0 0.4vh #000;
	}
	.details {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.brand {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 1vw;
	}
	.box {
		font-family: var(--font-head);
		font-size: 4vh;
		letter-spacing: 0.04em;
		color: var(--yellow);
		text-shadow: 0.3vh 0.3vh 0 #b0302a;
		white-space: nowrap;
	}
	.clock {
		font-family: var(--font-osd);
		font-size: 6vh;
		line-height: 1;
	}
	.date {
		font-family: var(--font-osd);
		font-size: 3vh;
		text-align: right;
		opacity: 0.85;
	}
	.sel {
		margin-top: auto;
		background: rgba(27, 52, 168, 0.55);
		border-left: 0.6vh solid var(--yellow);
		padding: 1.2vh 1.6vh;
	}
	.sel-head {
		font-family: var(--font-head);
		font-size: 2.6vh;
		letter-spacing: 0.05em;
	}
	.sel-num {
		color: var(--yellow);
		margin-right: 1vh;
	}
	.sel-title {
		font-weight: 700;
		font-size: 3.4vh;
		line-height: 1.1;
		margin-top: 0.4vh;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.sel-time {
		font-family: var(--font-osd);
		font-size: 2.8vh;
	}
	.later {
		list-style: none;
		margin: 0.6vh 0 0;
		padding: 0.6vh 0 0;
		border-top: 0.2vh solid rgba(255, 255, 255, 0.18);
		font-size: 2.4vh;
	}
	.later li {
		display: flex;
		gap: 1.2vh;
		white-space: nowrap;
	}
	.at {
		font-family: var(--font-osd);
		color: var(--yellow);
		flex: none;
	}
	.lt {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.blurb {
		font-size: 2.3vh;
		opacity: 0.85;
		margin-top: 0.4vh;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.grid {
		padding: 0 4vw 2vh;
		display: flex;
		flex-direction: column;
		gap: 0.5vh;
		min-height: 0;
		overflow: hidden;
	}
	/* The rows take the space left; the footer always stays on screen. */
	.rows {
		display: flex;
		flex-direction: column;
		gap: 0.5vh;
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}
	.row {
		display: grid;
		grid-template-columns: 22vw 1fr;
		gap: 0.5vh;
		height: 6.4vh;
		flex: none;
	}
	.ch {
		display: flex;
		align-items: center;
		gap: 1vw;
		padding: 0 1.2vw;
		background: var(--grid-dark);
		font-family: var(--font-head);
		font-size: 2.5vh;
		letter-spacing: 0.04em;
		white-space: nowrap;
		overflow: hidden;
	}
	.n {
		color: var(--yellow);
		min-width: 3.2vh;
		text-align: right;
	}
	.nm {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.track {
		position: relative;
		overflow: hidden;
	}
	.cell {
		position: absolute;
		top: 0;
		bottom: 0;
		display: flex;
		align-items: center;
		gap: 0.6vh;
		padding: 0 1vw;
		background: var(--grid);
		border-right: 0.5vh solid var(--navy);
		font-weight: 700;
		font-size: 2.7vh;
		white-space: nowrap;
		overflow: hidden;
	}
	.t {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.cont {
		font-size: 1.8vh;
		opacity: 0.7;
	}
	.row.selected .ch {
		background: var(--yellow);
		color: #101010;
	}
	.row.selected .ch .n {
		color: #b0302a;
	}
	.row.selected .cell {
		background: var(--grid-hi);
	}
	.times {
		height: 4.4vh;
	}
	.times .ch {
		background: transparent;
		color: var(--yellow);
		font-size: 2.2vh;
	}
	.arrow {
		font-size: 1.6vh;
	}
	.slot {
		position: absolute;
		top: 0;
		bottom: 0;
		display: flex;
		align-items: center;
		padding-left: 1vw;
		border-left: 0.3vh solid var(--yellow);
		font-family: var(--font-osd);
		font-size: 3.2vh;
		color: var(--yellow);
	}
	.row {
		cursor: pointer;
	}
	.now-line {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 0.4vh;
		margin-left: -0.2vh;
		background: #ff5a5a;
		z-index: 2;
		pointer-events: none;
	}
	.ahead {
		float: right;
		font-family: var(--font-osd);
		color: var(--yellow);
		letter-spacing: 0;
	}
	.touch {
		display: none;
	}
	@media (pointer: coarse) {
		.keys {
			display: none;
		}
		.touch {
			display: block;
		}
	}

	/* ── Portrait (a phone held upright) ─────────────────────────────── */
	@media (orientation: portrait) {
		.guide {
			grid-template-rows: auto 1fr;
		}
		header {
			grid-template-columns: 1fr;
			padding: 2vh 4vw 1vh;
			gap: 1.5vh;
		}
		/* The page puts the live picture over this 16:9 window. */
		.window {
			box-sizing: border-box;
			width: 100%;
			aspect-ratio: 16 / 9;
		}
		.box {
			font-size: 6vw;
		}
		.clock {
			font-size: 8vw;
		}
		.date {
			font-size: 3.6vw;
		}
		/* Compact card: now and the one after; the grid shows the rest. */
		.sel {
			margin-top: 0.6vh;
			padding: 0.8vh 3vw;
		}
		.sel-head {
			font-size: 3.4vw;
		}
		.sel-title {
			font-size: 4.6vw;
			-webkit-line-clamp: 1;
			line-clamp: 1;
		}
		.sel-time {
			font-size: 3.6vw;
		}
		.later {
			font-size: 3.6vw;
			margin-top: 0.3vh;
			padding-top: 0.3vh;
		}
		.later li:nth-child(n + 2) {
			display: none;
		}
		.blurb {
			font-size: 3.4vw;
			-webkit-line-clamp: 1;
			line-clamp: 1;
		}
		.date {
			display: none;
		}
		.row {
			grid-template-columns: 30vw 1fr;
			height: 5.2vh;
		}
		.ch {
			font-size: 3.4vw;
		}
		.cell {
			font-size: 3.6vw;
		}
		.slot {
			font-size: 3.8vw;
		}
		.times .ch {
			font-size: 3vw;
		}
		footer {
			font-size: 3vw;
		}
	}

	footer {
		flex: none;
		padding-top: 0.5vh;
		font-family: var(--font-osd);
		font-size: 2.6vh;
		letter-spacing: 0.06em;
		opacity: 0.7;
		text-align: center;
	}
</style>
