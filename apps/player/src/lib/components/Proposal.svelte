<script lang="ts">
	/**
	 * A channel an agent proposed, waiting for the owner. OK on the remote adds
	 * it, BACK declines it (the page routes the keys; the buttons are for touch
	 * and mouse). The proposal workflow waits for this answer.
	 */
	import type { ProposalSummary } from '@box/core';

	let {
		proposal,
		busy,
		error,
		onanswer
	}: { proposal: ProposalSummary; busy: boolean; error: string | null; onanswer: (approve: boolean) => void } = $props();

	const length = $derived.by(() => {
		const h = Math.floor(proposal.totalSec / 3600);
		const m = Math.round((proposal.totalSec % 3600) / 60);
		return h ? `${h} hr ${m} min` : `${m} min`;
	});
	const left = $derived.by(() => {
		const s = proposal.expiresAt - Date.now() / 1000;
		if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
		if (s < 86_400) return `${Math.round(s / 3600)} hr`;
		return `${Math.round(s / 86_400)} days`;
	});
</script>

<div class="card" role="dialog" aria-label="New channel proposed">
	<div class="head">
		<span class="tag">NEW CHANNEL PROPOSED</span>
		{#if proposal.from}<span class="from">FROM {proposal.from.toUpperCase()}</span>{/if}
	</div>
	<div class="title"><span class="num">{proposal.num}</span><span class="name">{proposal.name}</span></div>
	{#if proposal.blurb}<p class="blurb">{proposal.blurb}</p>{/if}
	<div class="meta">{proposal.items} SHOWS · {length} LOOP · ANSWER WITHIN {left.toUpperCase()}</div>
	<ol class="titles">
		{#each proposal.titles as t}<li>{t}</li>{/each}
	</ol>
	{#if error}<div class="error">{error}</div>{/if}
	<div class="actions">
		<button class="yes" disabled={busy} onclick={() => onanswer(true)}><kbd>OK</kbd> ADD IT</button>
		<button class="no" disabled={busy} onclick={() => onanswer(false)}><kbd>BACK</kbd> NO THANKS</button>
	</div>
</div>

<style>
	.card {
		position: absolute;
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
		width: min(86vw, 120vh);
		z-index: 60;
		padding: 3.5vh 4vh;
		background: linear-gradient(180deg, rgba(14, 28, 120, 0.97), rgba(6, 12, 60, 0.97));
		border: 0.4vh solid #6f8cff;
		box-shadow:
			0 0 0 0.4vh #000,
			0 2vh 6vh rgba(0, 0, 0, 0.7);
		color: var(--white);
	}
	.head {
		display: flex;
		justify-content: space-between;
		gap: 2vh;
		font-family: var(--font-osd);
		font-size: 3vh;
		letter-spacing: 0.08em;
	}
	.tag {
		color: var(--osd);
		text-shadow: 0 0 1vh var(--osd-glow);
	}
	.from {
		opacity: 0.8;
	}
	.title {
		display: flex;
		align-items: baseline;
		gap: 2.5vh;
		margin: 1.6vh 0 0.6vh;
	}
	.num {
		font-family: var(--font-head);
		font-size: 8vh;
		color: var(--yellow);
		text-shadow: 0.4vh 0.4vh 0 #b0302a;
	}
	.name {
		font-family: var(--font-head);
		font-size: 5vh;
		letter-spacing: 0.04em;
	}
	.blurb {
		font-size: 3vh;
		margin: 0 0 1vh;
		opacity: 0.9;
	}
	.meta {
		font-family: var(--font-osd);
		font-size: 2.8vh;
		color: var(--yellow);
	}
	.titles {
		margin: 1.4vh 0 2vh;
		padding-left: 3.5vh;
		font-size: 2.8vh;
		line-height: 1.35;
	}
	.titles li {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.error {
		font-family: var(--font-osd);
		font-size: 2.6vh;
		color: #ff6b6b;
		margin-bottom: 1.4vh;
	}
	.actions {
		display: flex;
		gap: 2.5vh;
	}
	button {
		flex: 1;
		font-family: var(--font-head);
		font-size: 3vh;
		letter-spacing: 0.05em;
		padding: 1.6vh 2vh;
		border: none;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.5;
	}
	kbd {
		font-family: var(--font-osd);
		font-size: 2.6vh;
		padding: 0 0.8vh;
		margin-right: 1vh;
		border: 0.2vh solid currentColor;
	}
	.yes {
		background: var(--yellow);
		color: #101010;
		box-shadow: 0.4vh 0.4vh 0 #b0302a;
	}
	.no {
		background: transparent;
		color: var(--white);
		border: 0.3vh solid #6f8cff;
	}
	@media (orientation: portrait) {
		.card {
			width: 92vw;
			padding: 2.4vh 4vw;
		}
		.head,
		.meta {
			font-size: 3.6vw;
		}
		.num {
			font-size: 11vw;
		}
		.name {
			font-size: 6.4vw;
		}
		.blurb,
		.titles {
			font-size: 3.8vw;
		}
		.actions {
			flex-direction: column;
		}
		button {
			font-size: 4.4vw;
		}
	}
</style>
