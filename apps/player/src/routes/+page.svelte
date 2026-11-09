<script lang="ts">
	/**
	 * The TV. One <video>, tuned by the shared clock: on every channel change
	 * we compute what is on now and how far in, load it, seek, and play.
	 *
	 * Remote (keyboard; CEC and IR remotes arrive as keys on the box):
	 *   ↑/↓ PgUp/PgDn  channel        hold ↑/↓   Turbo Tunnel surf
	 *   0–9            direct tune    G/Enter    guide
	 *   I info · M mute · B bubbles · C CRT mode · Esc back
	 */
	import { onMount } from 'svelte';
	import { whatsOn, type Airing } from '@box/core';
	import { channelAirings, guide, now, onAir, pad2, type GuideChannel } from '$lib/guide.svelte';
	import type Hls from 'hls.js';
	import { blip, setMuted, staticBurst, unlockAudio } from '$lib/sound';
	import Static from '$lib/components/Static.svelte';
	import Osd from '$lib/components/Osd.svelte';
	import InfoBanner from '$lib/components/InfoBanner.svelte';
	import Guide from '$lib/components/Guide.svelte';
	import Bubbles from '$lib/components/Bubbles.svelte';
	import Cards from '$lib/components/Cards.svelte';
	import Setec from '$lib/components/Setec.svelte';
	import Setup from '$lib/components/Setup.svelte';

	// ── persisted preferences (best effort; private windows may refuse) ─────
	const store = {
		get(key: string): string | null {
			try {
				return localStorage.getItem(`box:${key}`);
			} catch {
				return null;
			}
		},
		set(key: string, value: string): void {
			try {
				localStorage.setItem(`box:${key}`, value);
			} catch {
				// ignore
			}
		}
	};

	let video: HTMLVideoElement;

	let powered = $state(false);
	let warming = $state(false);
	let current = $state<GuideChannel | null>(null);
	let airing = $state<Airing | null>(null);
	let screen = $state<'video' | 'card' | 'empty' | 'standby'>('video');
	let position = $state(0); // seconds into the current item, for bubbles
	let tick = $state(0);

	let guideOpen = $state(false);
	/** How far ahead the guide looks, in 30-minute steps (0 = now, up to 12 hours). */
	let guidePage = $state(0);
	const GUIDE_MAX_PAGE = 24;
	let guideSel = $state<string | null>(null);
	let infoVisible = $state(false);
	let osdVisible = $state(false);
	let osdText = $state('');
	let osdLabel = $state('');
	let staticOn = $state(false);
	let turbo = $state(false);
	let turboIndex = -1;
	let digits = $state('');
	let setec = $state(false);
	let setup = $state(false);
	/** On the box, Chromium opens the TV with ?kiosk: it turns on by itself. */
	const kiosk = typeof location !== 'undefined' && new URLSearchParams(location.search).has('kiosk');
	let muted = $state(store.get('muted') === '1');
	let crt = $state(store.get('crt') === '1');
	let bubblesOn = $state(store.get('bubbles') !== '0');
	let countdown = $state(9);
	/** Some old transfers are stored squeezed (e.g. 368×480); show them at 4:3. */
	let squeezed = $state(false);

	let loadedUrl = '';
	let hls: Hls | null = null;
	let osdTimer: ReturnType<typeof setTimeout> | undefined;
	let infoTimer: ReturnType<typeof setTimeout> | undefined;
	let digitTimer: ReturnType<typeof setTimeout> | undefined;
	let staticTimer: ReturnType<typeof setTimeout> | undefined;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let countdownTimer: ReturnType<typeof setInterval> | undefined;

	const channels = $derived(guide.data?.channels ?? []);

	const nextUp = $derived.by(() => {
		void tick;
		if (!current || current.kind === 'card') return null;
		return channelAirings(current, now(), Infinity, 2)[1]?.item.title ?? null;
	});

	// ── overlays ─────────────────────────────────────────────────────────────

	function flashOsd(text: string, label = '', ms = 2500): void {
		osdText = text;
		osdLabel = label;
		osdVisible = true;
		clearTimeout(osdTimer);
		osdTimer = setTimeout(() => (osdVisible = false), ms);
	}

	function showInfo(ms = 5000): void {
		infoVisible = true;
		clearTimeout(infoTimer);
		infoTimer = setTimeout(() => (infoVisible = false), ms);
	}

	function flashStatic(ms = 420): void {
		staticOn = true;
		staticBurst(ms);
		clearTimeout(staticTimer);
		staticTimer = setTimeout(() => (staticOn = false), ms);
	}

	// ── tuning ───────────────────────────────────────────────────────────────

	function tune(ch: GuideChannel | undefined, opts: { quiet?: boolean } = {}): void {
		if (!ch) return;
		current = ch;
		store.set('channel', ch.id);
		stopCountdown();
		// Tell the API, for the front-panel LED. Fire and forget.
		fetch('/api/tuned', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ channelId: ch.id, num: ch.num })
		}).catch(() => {});
		if (!opts.quiet) {
			flashStatic();
			flashOsd(pad2(ch.num), ch.name);
			showInfo();
		}
		play();
	}

	function stopVideo(): void {
		loadedUrl = '';
		hls?.destroy();
		hls = null;
		video?.removeAttribute('src');
		video?.load();
	}

	/**
	 * Point the <video> at a URL. HLS always goes through hls.js when the
	 * browser has Media Source Extensions: newer Chrome claims native HLS
	 * ("maybe") but fails on ad-stitched streams. Native HLS is the fallback
	 * (iOS Safari has no MSE).
	 */
	function setSource(url: string): void {
		hls?.destroy();
		hls = null;
		loadedUrl = url;
		const isHls = /\.m3u8(\?|$)/i.test(url) || current?.kind === 'live';
		if (!isHls) {
			video.src = url;
			return;
		}
		import('hls.js').then(({ default: Hls }) => {
			if (loadedUrl !== url) return; // tuned away while it loaded
			if (!Hls.isSupported()) {
				video.src = url;
				return;
			}
			const h = new Hls({ maxBufferLength: 20, backBufferLength: 30 });
			h.on(Hls.Events.ERROR, (_e, d) => {
				if (!d.fatal || hls !== h) return;
				console.warn(`[tv] stream error: ${d.type} ${d.details}${d.reason ? ` (${d.reason})` : ''}`, d.response?.code ?? '');
				onVideoError();
			});
			h.loadSource(url);
			h.attachMedia(video);
			hls = h;
		});
	}

	/** Load whatever the clock says is on now. Safe to call any time. */
	function play(): void {
		clearTimeout(retryTimer);
		if (!current) return;
		if (current.kind === 'card') {
			stopCountdown();
			airing = null;
			screen = current.card === 'standby' ? 'standby' : 'card';
			stopVideo();
			return;
		}
		if (current.kind === 'live') {
			// Through the box API, which follows redirects that lack CORS headers.
			const url = guide.data?.live?.[current.id]?.url ? `/api/live/${encodeURIComponent(current.id)}` : null;
			if (!url) {
				airing = null;
				screen = 'empty';
				stopVideo();
				if (!countdownTimer) startCountdown();
				return;
			}
			stopCountdown();
			airing = channelAirings(current, now(), now() + 1, 1)[0] ?? null;
			screen = 'video';
			if (loadedUrl !== url) setSource(url);
			else video.play().catch(() => {});
			return;
		}
		const flat = guide.data?.schedules[current.id];
		const a = flat ? whatsOn(flat, now()) : null;
		if (!a?.item.url) {
			airing = null;
			screen = 'empty';
			stopVideo();
			if (!countdownTimer) startCountdown();
			return;
		}
		stopCountdown();
		airing = a;
		screen = 'video';
		if (loadedUrl !== a.item.url) {
			setSource(a.item.url);
		} else {
			syncPosition(true);
			video.play().catch(() => {});
		}
	}

	/**
	 * The file ran out. Usually the next item is on now; if the file was
	 * shorter than its listed length, stand by until the schedule moves on.
	 */
	function onEnded(): void {
		if (current?.kind === 'live') {
			// A live stream should not end; treat it as a dropout and retune.
			loadedUrl = '';
			retryTimer = setTimeout(play, 2000);
			return;
		}
		const flat = current && guide.data?.schedules[current.id];
		const a = flat ? whatsOn(flat, now()) : null;
		if (a && airing && a.item.id === airing.item.id) {
			screen = 'standby';
			loadedUrl = '';
			retryTimer = setTimeout(play, Math.max(0, a.endsAt - now()) * 1000 + 200);
			return;
		}
		play();
	}

	/** Seek to where the clock says we should be. */
	function syncPosition(force = false): void {
		if (current?.kind === 'live') {
			// No clock to follow; just keep the banner on the current program.
			airing = channelAirings(current, now(), now() + 1, 1)[0] ?? airing;
			return;
		}
		if (!airing || !video || video.readyState < 1) return;
		const flat = current && guide.data?.schedules[current.id];
		const a = flat ? whatsOn(flat, now()) : null;
		if (!a || a.item.id !== airing.item.id || a.item.url !== loadedUrl) {
			play(); // the schedule moved on (item ended or the channel was edited)
			return;
		}
		airing = a;
		const drift = Math.abs(video.currentTime - a.offsetSec);
		if (force || drift > 4) video.currentTime = a.offsetSec;
	}

	function onLoadedMetadata(): void {
		squeezed = video.videoHeight > 0 && video.videoWidth / video.videoHeight < 1;
		syncPosition(true);
		video.play().catch(() => {
			// autoplay blocked: the power-on key press normally prevents this
		});
	}

	function onVideoError(): void {
		if (!loadedUrl) return;
		screen = 'standby';
		loadedUrl = '';
		retryTimer = setTimeout(play, 10_000);
	}

	function startCountdown(): void {
		countdown = 9;
		countdownTimer = setInterval(() => {
			countdown -= 1;
			if (countdown < 0) {
				stopCountdown();
				step(1);
			}
		}, 1000);
	}
	function stopCountdown(): void {
		clearInterval(countdownTimer);
		countdownTimer = undefined;
	}

	function indexOf(id: string | undefined): number {
		return Math.max(0, channels.findIndex((c) => c.id === id));
	}

	function step(dir: 1 | -1): void {
		if (channels.length === 0) return;
		const i = (indexOf(current?.id) + dir + channels.length) % channels.length;
		tune(channels[i]);
	}

	function tuneNumber(num: number): void {
		if (num === 1992) {
			setec = true;
			return;
		}
		if (num === 0) {
			setup = true;
			guideOpen = false;
			return;
		}
		const ch = channels.find((c) => c.num === num);
		if (ch) {
			tune(ch);
			guideOpen = false;
		} else flashOsd(pad2(num), 'NO SIGNAL', 1800);
	}

	// ── remote ───────────────────────────────────────────────────────────────

	function powerOn(): void {
		if (powered || warming) return;
		unlockAudio();
		setMuted(muted);
		warming = true;
		setTimeout(() => {
			warming = false;
			powered = true;
			const saved = guide.channel(store.get('channel') ?? undefined);
			tune(saved ?? channels[0]);
		}, 650);
	}

	function toggle(key: 'muted' | 'crt' | 'bubbles'): void {
		if (key === 'muted') {
			muted = !muted;
			setMuted(muted);
			store.set('muted', muted ? '1' : '0');
			flashOsd(muted ? 'MUTE' : 'VOL', '', 1500);
		} else if (key === 'crt') {
			crt = !crt;
			store.set('crt', crt ? '1' : '0');
			flashOsd(crt ? 'CRT' : 'HD', '', 1200);
		} else {
			bubblesOn = !bubblesOn;
			store.set('bubbles', bubblesOn ? '1' : '0');
			flashOsd(bubblesOn ? 'POP-UPS' : 'NO POP', 'B TO TOGGLE', 1500);
		}
	}

	function onKey(e: KeyboardEvent): void {
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		if (!powered) {
			e.preventDefault();
			powerOn();
			return;
		}
		if (setec) return;
		if (setup) {
			e.preventDefault();
			setup = false;
			return;
		}
		const k = e.key;

		if (/^[0-9]$/.test(k)) {
			e.preventDefault();
			blip(660 + Number(k) * 40);
			digits = (digits + k).slice(-4);
			flashOsd(digits.padEnd(2, '-'), '', 2200);
			clearTimeout(digitTimer);
			digitTimer = setTimeout(() => {
				const n = Number(digits);
				digits = '';
				tuneNumber(n);
			}, digits.length >= 4 ? 300 : 1500);
			return;
		}

		const up = k === 'ArrowUp' || k === 'PageUp' || k === '+' || k === '=';
		const down = k === 'ArrowDown' || k === 'PageDown' || k === '-' || k === '_';

		if (guideOpen) {
			if (up || down) {
				e.preventDefault();
				const i = indexOf(guideSel ?? current?.id);
				guideSel = channels[(i + (down ? 1 : -1) + channels.length) % channels.length]?.id ?? null;
				blip(520);
			} else if (k === 'ArrowRight' || k === 'ArrowLeft') {
				// Look ahead (or back toward now) in 30-minute steps.
				e.preventDefault();
				const next = Math.min(GUIDE_MAX_PAGE, Math.max(0, guidePage + (k === 'ArrowRight' ? 1 : -1)));
				if (next !== guidePage) blip(k === 'ArrowRight' ? 600 : 480);
				guidePage = next;
			} else if (k === 'Enter' || k === ' ') {
				e.preventDefault();
				guideOpen = false;
				const ch = guide.channel(guideSel ?? undefined);
				if (ch && ch.id !== current?.id) tune(ch);
			} else if (k === 'Escape' || k === 'Backspace' || k === 'g' || k === 'G') {
				guideOpen = false;
			}
			return;
		}

		if (up || down) {
			e.preventDefault();
			if (e.repeat) {
				// Turbo Tunnel: surf without loading video until the key is released.
				turbo = true;
				turboIndex = (turboIndex < 0 ? indexOf(current?.id) : turboIndex) + (up ? 1 : -1);
				turboIndex = (turboIndex + channels.length) % channels.length;
				const ch = channels[turboIndex];
				if (ch) flashOsd(pad2(ch.num), ch.name, 1200);
				if (current?.num === 88 || ch?.num === 88) flashOsd('88', '88 MPH', 1200);
				return;
			}
			step(up ? 1 : -1);
			return;
		}

		switch (k) {
			case 'g':
			case 'G':
			case 'Enter':
				e.preventDefault();
				guideSel = current?.id ?? channels[0]?.id ?? null;
				guidePage = 0;
				guideOpen = true;
				infoVisible = false;
				break;
			case 'i':
			case 'I':
				showInfo(6000);
				flashOsd(pad2(current?.num ?? 0), current?.name ?? '');
				break;
			case 'm':
			case 'M':
				toggle('muted');
				break;
			case 'c':
			case 'C':
				toggle('crt');
				break;
			case 'b':
			case 'B':
				toggle('bubbles');
				break;
			case 's':
			case 'S':
				setup = true;
				break;
			case 'Escape':
				infoVisible = false;
				osdVisible = false;
				break;
		}
	}

	function onKeyUp(e: KeyboardEvent): void {
		if (!turbo) return;
		if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', '+', '-', '=', '_'].includes(e.key)) {
			turbo = false;
			const ch = channels[turboIndex];
			turboIndex = -1;
			tune(ch);
		}
	}

	let wheelLock = 0;
	// ── touch (a phone over Tailscale) ───────────────────────────────────────
	// Swipe up/down: channel (guide: move). Tap: info (guide: tune).
	// Long press: guide on/off. Every gesture becomes the matching key.
	let touchStart: { x: number; y: number } | null = null;
	let longPressed = false;
	let longTimer: ReturnType<typeof setTimeout> | undefined;
	const press = (key: string): void => onKey(new KeyboardEvent('keydown', { key }));

	function onTouchStart(e: TouchEvent): void {
		if (!powered || e.touches.length !== 1) return;
		touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
		longPressed = false;
		clearTimeout(longTimer);
		longTimer = setTimeout(() => {
			longPressed = true;
			press('g');
		}, 600);
	}
	function onTouchMove(e: TouchEvent): void {
		if (!touchStart) return;
		const t = e.touches[0];
		if (Math.hypot(t.clientX - touchStart.x, t.clientY - touchStart.y) > 12) clearTimeout(longTimer);
	}
	function onTouchEnd(e: TouchEvent): void {
		clearTimeout(longTimer);
		if (!touchStart || longPressed) return void (touchStart = null);
		const t = e.changedTouches[0];
		const dx = t.clientX - touchStart.x;
		const dy = t.clientY - touchStart.y;
		touchStart = null;
		if (Math.abs(dy) > 40 && Math.abs(dy) > Math.abs(dx)) press(dy < 0 ? 'ArrowUp' : 'ArrowDown');
		// Sideways in the guide: swipe left to look ahead, right to come back.
		else if (guideOpen && Math.abs(dx) > 40) press(dx < 0 ? 'ArrowRight' : 'ArrowLeft');
		// A tap in the guide is a row click (pickRow); elsewhere it shows info.
		else if (Math.hypot(dx, dy) < 12 && !guideOpen) press(setup ? 'Escape' : 'i');
	}

	/** Click or tap a guide row: the first selects it, a second tunes it. */
	function pickRow(id: string): void {
		if (guideSel === id) {
			press('Enter');
			return;
		}
		guideSel = id;
		blip(520);
	}

	function onWheel(e: WheelEvent): void {
		if (!powered || Date.now() < wheelLock) return;
		if (guideOpen) {
			// Trackpad: sideways moves time, up/down moves the selection.
			const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY);
			const d = sideways ? e.deltaX : e.deltaY;
			if (Math.abs(d) < 20) return;
			wheelLock = Date.now() + 250;
			press(sideways ? (d > 0 ? 'ArrowRight' : 'ArrowLeft') : d > 0 ? 'ArrowDown' : 'ArrowUp');
			return;
		}
		if (Math.abs(e.deltaY) < 20) return;
		wheelLock = Date.now() + 400;
		step(e.deltaY < 0 ? 1 : -1);
	}

	// ── lifecycle ────────────────────────────────────────────────────────────

	onMount(() => {
		guide.start();
		const iv = setInterval(() => {
			tick += 1;
			if (screen === 'video' && video && !video.ended && video.readyState >= 1) {
				syncPosition();
				if (video.paused && video.readyState >= 2) video.play().catch(() => {});
			}
		}, 1000);
		const pos = () => {
			if (video && airing) position = video.currentTime;
			raf = requestAnimationFrame(pos);
		};
		let raf = requestAnimationFrame(pos);
		const moved = () => {
			document.body.classList.add('pointer');
			clearTimeout(pointerTimer);
			pointerTimer = setTimeout(() => document.body.classList.remove('pointer'), 2500);
		};
		let pointerTimer: ReturnType<typeof setTimeout> | undefined;
		window.addEventListener('mousemove', moved);
		return () => {
			clearInterval(iv);
			cancelAnimationFrame(raf);
			window.removeEventListener('mousemove', moved);
		};
	});

	// Guide data refreshed: follow edits (renames, new items, removed channel).
	$effect(() => {
		const data = guide.data;
		if (data && kiosk && !powered && !warming) powerOn();
		if (!data || !powered) return;
		if (!current) {
			// Turned on before the first guide load arrived.
			if (data.channels.length) tune(guide.channel(store.get('channel') ?? undefined) ?? data.channels[0]);
			return;
		}
		const fresh = data.channels.find((c) => c.id === current!.id);
		if (!fresh) {
			tune(data.channels[0], { quiet: false });
			return;
		}
		if (fresh !== current) {
			current = fresh;
			// Cards redraw on their own; an empty channel only needs a retune
			// once it has something to air.
			if (screen === 'standby' || (screen === 'empty' && onAir(fresh))) play();
		}
	});
</script>

<svelte:window
	onkeydown={onKey}
	onkeyup={onKeyUp}
	onwheel={onWheel}
	ontouchstart={onTouchStart}
	ontouchmove={onTouchMove}
	ontouchend={onTouchEnd}
/>

<main class:crt class:guide-open={guideOpen}>
	<div class="picture" class:hidden={screen !== 'video'}>
		<!-- svelte-ignore a11y_media_has_caption -->
		<video
			class:squeezed
			bind:this={video}
			muted={muted}
			playsinline
			preload="auto"
			onloadedmetadata={onLoadedMetadata}
			onended={onEnded}
			onerror={onVideoError}
		></video>
	</div>

	{#if powered && screen !== 'video'}
		<Cards
			kind={screen === 'card' ? (current?.card === 'notices' ? 'notices' : 'clock') : screen === 'standby' ? 'standby' : 'empty'}
			channel={current}
			{tick}
			{countdown}
		/>
	{/if}

	{#if powered && screen === 'video' && airing?.item.bubbles?.length && !guideOpen}
		<Bubbles bubbles={airing.item.bubbles} {position} enabled={bubblesOn} />
	{/if}

	<Guide open={guideOpen} selected={guideSel} {tick} page={guidePage} onpick={pickRow} />

	<InfoBanner channel={current} {airing} next={nextUp} visible={infoVisible && !guideOpen} {tick} />
	<Osd text={osdText} label={osdLabel} visible={osdVisible} {turbo} />
	<Static active={staticOn} />

	{#if setec}
		<Setec done={() => (setec = false)} />
	{/if}

	{#if setup}
		<Setup />
	{/if}

	{#if crt}<div class="scanlines" aria-hidden="true"></div>{/if}

	{#if !powered}
		<button class="power" class:warming onclick={powerOn}>
			{#if guide.error && !guide.data}
				<span class="msg">PLEASE STAND BY</span>
				<span class="hint">The box is waking up. ({guide.error})</span>
			{:else}
				<span class="msg blink keys">PRESS ANY KEY TO TURN ON THE TV</span>
				<span class="hint keys">↑↓ CHANNEL · 0–9 TUNE · G GUIDE · I INFO · M MUTE · B POP-UPS · C CRT · 0 SETUP</span>
				<span class="msg blink touch">TAP TO TURN ON THE TV</span>
				<span class="hint touch">SWIPE ↑↓ CHANNEL · TAP INFO · HOLD GUIDE</span>
			{/if}
		</button>
	{/if}
</main>

<style>
	/* Phones and tablets get touch hints instead of key hints. */
	.touch {
		display: none;
	}
	@media (pointer: coarse) {
		.keys {
			display: none;
		}
		.touch {
			display: inline;
		}
	}
	main {
		position: fixed;
		inset: 0;
		background: #000;
		overflow: hidden;
		/* Gestures are the remote on a phone: no scroll, zoom or text selection. */
		touch-action: none;
		user-select: none;
		-webkit-user-select: none;
		-webkit-touch-callout: none;
	}

	.picture {
		position: absolute;
		inset: 0;
		z-index: 22;
		background: #000;
		transition:
			top 260ms ease-out,
			left 260ms ease-out,
			width 260ms ease-out,
			height 260ms ease-out;
	}
	.picture.hidden {
		visibility: hidden;
	}
	video {
		width: 100%;
		height: 100%;
		object-fit: contain;
		display: block;
		background: #000;
	}
	video.squeezed {
		object-fit: fill;
		width: auto;
		aspect-ratio: 4 / 3;
		max-width: 100%;
		margin: 0 auto;
	}
	/* Guide open: the picture moves into the guide's preview window. */
	.guide-open .picture {
		top: 3.4vh;
		left: calc(4vw + 0.4vh);
		width: calc((100vw - 8vw - 2.5vw) / 2 - 0.8vh);
		height: calc(46vh - 4.5vh - 0.8vh);
	}
	/* Portrait guide: the window is full width and 16:9 (Guide.svelte). */
	@media (orientation: portrait) {
		.guide-open .picture {
			top: calc(2vh + 0.4vh);
			left: calc(4vw + 0.4vh);
			width: calc(92vw - 0.8vh);
			height: calc(92vw * 9 / 16 - 0.8vh);
		}
	}

	.crt video {
		filter: contrast(1.1) saturate(1.15) blur(0.3px);
	}
	.crt:not(.guide-open) .picture {
		left: 50%;
		width: min(100vw, 133.33vh);
		transform: translateX(-50%);
	}
	.scanlines {
		position: absolute;
		inset: 0;
		z-index: 50;
		pointer-events: none;
		background:
			repeating-linear-gradient(180deg, rgba(0, 0, 0, 0.28) 0 1px, transparent 1px 3px),
			radial-gradient(ellipse at center, transparent 55%, rgba(0, 0, 0, 0.55) 100%);
		mix-blend-mode: multiply;
	}

	.power {
		position: absolute;
		inset: 0;
		z-index: 60;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 3vh;
		background: #000;
		border: 0;
		color: var(--osd);
		font-family: var(--font-osd);
		cursor: pointer;
	}
	.msg {
		font-size: 6vh;
		text-shadow: 0 0 0.4em var(--osd-glow);
	}
	.hint {
		font-size: 2.8vh;
		color: var(--white);
		opacity: 0.6;
		letter-spacing: 0.06em;
	}
	.blink {
		animation: blink 1.1s steps(2, start) infinite;
	}
	@keyframes blink {
		to {
			visibility: hidden;
		}
	}
	/* CRT warm-up: a bright line that opens into the picture. */
	.power.warming {
		background: transparent;
		pointer-events: none;
	}
	.power.warming::before {
		content: '';
		position: absolute;
		inset: 0;
		background: #000;
		animation: open 650ms ease-in forwards;
	}
	.power.warming::after {
		content: '';
		position: absolute;
		left: 0;
		right: 0;
		top: 50%;
		height: 0.6vh;
		background: #fff;
		box-shadow: 0 0 4vh 1vh #fff;
		animation: line 650ms ease-in forwards;
	}
	.power.warming span {
		display: none;
	}
	@keyframes line {
		0% {
			transform: scaleX(0.02);
		}
		45% {
			transform: scaleX(1);
			opacity: 1;
		}
		100% {
			transform: scaleY(80);
			opacity: 0;
		}
	}
	@keyframes open {
		0%,
		45% {
			opacity: 1;
		}
		100% {
			opacity: 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.blink {
			animation: none;
		}
	}
</style>
