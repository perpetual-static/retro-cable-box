import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const api = `http://127.0.0.1:${process.env.API_PORT ?? 8760}`;

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		proxy: { '/api': api, '/media': api },
		// Reach the dev TV from a phone over Tailscale (tailscale serve) or the LAN.
		allowedHosts: ['.ts.net', '.local']
	}
});
