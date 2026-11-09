<script lang="ts">
	/** Channel-change snow with a rolling bar, drawn small and scaled up. */
	let { active }: { active: boolean } = $props();
	let canvas: HTMLCanvasElement;

	$effect(() => {
		if (!active || !canvas) return;
		const ctx = canvas.getContext('2d')!;
		const w = canvas.width;
		const h = canvas.height;
		const img = ctx.createImageData(w, h);
		let frame = 0;
		let raf = 0;
		const draw = () => {
			const bar = (frame * 7) % h;
			for (let y = 0; y < h; y += 1) {
				const roll = Math.abs(y - bar) < 6 ? 60 : 0;
				for (let x = 0; x < w; x += 1) {
					const v = Math.min(255, ((Math.random() * 255) | 0) + roll);
					const i = (y * w + x) * 4;
					img.data[i] = v;
					img.data[i + 1] = v;
					img.data[i + 2] = v;
					img.data[i + 3] = 255;
				}
			}
			ctx.putImageData(img, 0, 0);
			frame += 1;
			raf = requestAnimationFrame(draw);
		};
		draw();
		return () => cancelAnimationFrame(raf);
	});
</script>

<canvas bind:this={canvas} class:active width="192" height="108" aria-hidden="true"></canvas>

<style>
	canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		image-rendering: pixelated;
		opacity: 0;
		pointer-events: none;
		transition: opacity 120ms linear;
		z-index: 30;
	}
	canvas.active {
		opacity: 1;
		transition: none;
	}
</style>
