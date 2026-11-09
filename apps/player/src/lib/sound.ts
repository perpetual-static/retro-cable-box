/**
 * Original sound effects, synthesized with WebAudio (no recorded clips):
 * a burst of channel-change static and a pop-up "bloop".
 */

let ctx: AudioContext | undefined;
let muted = false;

export function setMuted(value: boolean): void {
	muted = value;
}

/** Must be called from a user gesture once (the power-on key press). */
export function unlockAudio(): void {
	ctx ??= new AudioContext();
	void ctx.resume();
}

export function staticBurst(ms = 320): void {
	if (!ctx || muted) return;
	const len = Math.floor((ctx.sampleRate * ms) / 1000);
	const buf = ctx.createBuffer(1, len, ctx.sampleRate);
	const data = buf.getChannelData(0);
	for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
	const src = ctx.createBufferSource();
	src.buffer = buf;
	const band = ctx.createBiquadFilter();
	band.type = 'bandpass';
	band.frequency.value = 2400;
	band.Q.value = 0.6;
	const gain = ctx.createGain();
	const t = ctx.currentTime;
	gain.gain.setValueAtTime(0.09, t);
	gain.gain.exponentialRampToValueAtTime(0.001, t + ms / 1000);
	src.connect(band).connect(gain).connect(ctx.destination);
	src.start();
}

export function bloop(): void {
	if (!ctx || muted) return;
	const t = ctx.currentTime;
	const osc = ctx.createOscillator();
	osc.type = 'sine';
	osc.frequency.setValueAtTime(520, t);
	osc.frequency.exponentialRampToValueAtTime(1350, t + 0.09);
	const gain = ctx.createGain();
	gain.gain.setValueAtTime(0.0001, t);
	gain.gain.exponentialRampToValueAtTime(0.22, t + 0.015);
	gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
	osc.connect(gain).connect(ctx.destination);
	osc.start(t);
	osc.stop(t + 0.18);
}

export function blip(freq = 880): void {
	if (!ctx || muted) return;
	const t = ctx.currentTime;
	const osc = ctx.createOscillator();
	osc.type = 'square';
	osc.frequency.value = freq;
	const gain = ctx.createGain();
	gain.gain.setValueAtTime(0.04, t);
	gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
	osc.connect(gain).connect(ctx.destination);
	osc.start(t);
	osc.stop(t + 0.07);
}
