<script lang="ts">
	/**
	 * Channel 0: how to reach this box from an agent (any MCP client). Shows the MCP address and a
	 * QR code for it, the token when one is set, and, when the box is on the
	 * internet, the pairing code that agent apps ask for when they sign in. Any key closes it.
	 */
	import qrcode from 'qrcode-generator';

	interface BoxInfo {
		boxName: string;
		version: string;
		lanMcpUrl: string;
		publicMcpUrl: string | null;
		token: string | null;
		pairCode: string | null;
		pairCodeTtl: number;
	}

	let info = $state<BoxInfo | null>(null);
	let failed = $state(false);

	// Poll so the pairing code changes on screen when it changes on the box.
	$effect(() => {
		const load = () =>
			fetch('/api/box')
				.then((r) => r.json())
				.then((d) => ((info = d), (failed = false)))
				.catch(() => (failed = info === null));
		load();
		const t = setInterval(load, 15_000);
		return () => clearInterval(t);
	});

	const url = $derived(info ? (info.publicMcpUrl ?? info.lanMcpUrl) : '');
	const qr = $derived.by(() => {
		if (!url) return '';
		const q = qrcode(0, 'M');
		q.addData(url);
		q.make();
		return q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
	});
</script>

<div class="setup">
	<div class="panel">
		<h1>CHANNEL 0 · SETUP</h1>
		{#if failed}
			<p>We are experiencing technical difficulties. The API did not answer.</p>
		{:else if info}
			<div class="cols">
				<div class="qr">{@html qr}</div>
				<div class="text">
					<div class="label">BOX</div>
					<div class="value">{info.boxName} <span class="dim">{info.version === 'dev' ? 'DEV BUILD' : `v${info.version}`}</span></div>
					<div class="label">CONNECT CLAUDE TO</div>
					<div class="value url">{url}</div>
					{#if info.publicMcpUrl}
						<div class="dim small">On your home network: {info.lanMcpUrl}</div>
					{/if}
					{#if info.token}
						<div class="label">TOKEN</div>
						<div class="value mono">{info.token}</div>
					{:else}
						<div class="dim small">No token set. Anyone on your network can program this box.</div>
					{/if}
					{#if info.pairCode}
						<div class="label">PAIRING CODE</div>
						<div class="value pair">{info.pairCode.slice(0, 3)} {info.pairCode.slice(3)}</div>
						<div class="dim small">Changes every 10 minutes.</div>
						<div class="how">
							Agent apps that sign in (for example, claude.ai custom connectors): paste the address, then type the pairing code when it asks.
						</div>
					{/if}
					<div class="how">
						Any MCP client: the address above, with the token as a Bearer header. For example, Claude Code: <code>claude mcp add --transport http retro-cable-box {info.lanMcpUrl}</code>
					</div>
				</div>
			</div>
		{/if}
		<footer>PRESS ANY KEY TO GO BACK · NO MATTER WHERE YOU GO, THERE YOU ARE.</footer>
	</div>
</div>

<style>
	.setup {
		position: absolute;
		inset: 0;
		z-index: 46;
		display: grid;
		place-items: center;
		background: repeating-linear-gradient(45deg, #0b1150 0 2vh, #0d1460 2vh 4vh);
	}
	.panel {
		width: 84vw;
		background: var(--navy);
		border: 0.5vh solid #6f8cff;
		box-shadow: 1.2vh 1.2vh 0 #000;
		padding: 4vh 4vw 3vh;
	}
	h1 {
		margin: 0 0 3vh;
		font-family: var(--font-head);
		font-size: 4.6vh;
		color: var(--yellow);
		letter-spacing: 0.05em;
	}
	.cols {
		display: grid;
		grid-template-columns: 36vh 1fr;
		gap: 4vw;
		align-items: start;
	}
	.qr {
		width: 36vh;
		height: 36vh;
		background: #fff;
		padding: 1vh;
	}
	.qr :global(svg) {
		width: 100%;
		height: 100%;
		display: block;
	}
	.label {
		font-family: var(--font-osd);
		font-size: 2.8vh;
		color: var(--yellow);
		margin-top: 2vh;
	}
	.label:first-child {
		margin-top: 0;
	}
	.value {
		font-weight: 700;
		font-size: 3.8vh;
		overflow-wrap: anywhere;
	}
	.url,
	.mono {
		font-family: var(--font-osd);
		font-size: 4.2vh;
		color: var(--osd);
	}
	.pair {
		font-family: var(--font-osd);
		font-size: 7vh;
		letter-spacing: 0.15em;
		color: var(--yellow);
		line-height: 1;
	}
	.dim {
		opacity: 0.7;
	}
	.small {
		font-size: 2.4vh;
		margin-top: 1vh;
	}
	.how {
		margin-top: 3vh;
		font-size: 2.4vh;
		opacity: 0.85;
	}
	code {
		font-family: var(--font-osd);
		font-size: 2.8vh;
		overflow-wrap: anywhere;
	}
	footer {
		margin-top: 3vh;
		font-family: var(--font-osd);
		font-size: 2.6vh;
		opacity: 0.7;
		text-align: center;
	}
	p {
		font-size: 3.4vh;
	}
</style>
