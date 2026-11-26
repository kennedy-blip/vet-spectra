// SPA mode: every route is client-rendered so the identical `build/` folder can
// be served by Vercel AND dropped into the Capacitor Android shell for offline
// use. No server-side rendering, no hydration mismatch, no Node runtime needed.
export const prerender = false;
export const ssr = false;

export const load = () => ({});
