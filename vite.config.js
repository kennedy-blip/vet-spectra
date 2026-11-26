import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

/**
 * VET-SPECTRA dev/preview config.
 *
 * The workstation is offline-first: every clinical engine runs in the browser and
 * the IndexedDB vault is the record of truth. The Python physics API is optional
 * and is proxied here so the running preview (and `npm run dev`) can reach
 * `python3 api/vet_physics.py` on :8099 without CORS or hard-coded hosts.
 */
const API_PROXY = {
	'/api': {
		target: process.env.VET_API_ORIGIN || 'http://127.0.0.1:8099',
		changeOrigin: true,
		secure: false
	}
};

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		host: '0.0.0.0',
		port: 5173,
		strictPort: false,
		allowedHosts: true,
		proxy: API_PROXY
	},
	preview: {
		host: '0.0.0.0',
		port: 4173,
		strictPort: false,
		allowedHosts: true,
		proxy: API_PROXY
	},
	build: {
		target: 'es2020',
		assetsInlineLimit: 0
	}
});
