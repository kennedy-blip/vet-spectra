import adapter from '@sveltejs/adapter-static';

/**
 * SvelteKit configuration — static SPA output so the exact same `build/`
 * directory ships to Vercel (web) and is bundled into the Capacitor
 * Android shell (offline .APK). No TypeScript anywhere in the project.
 * @type {import('@sveltejs/kit').Config}
 */
const config = {
	kit: {
		adapter: adapter({
			pages: 'build',
			assets: 'build',
			fallback: 'index.html',
			precompress: false,
			strict: false
		}),
		prerender: { entries: [] }
	}
};

export default config;
