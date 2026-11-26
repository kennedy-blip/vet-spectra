<script>
	import { onDestroy, onMount } from 'svelte';
	import { clockHHMM, isoDay } from '$lib/utils/format.js';
	import { syncState } from '$lib/stores/vetStore.js';

	export let active = false;

	let now = new Date();
	let timer = null;

	onMount(() => {
		timer = setInterval(() => (now = new Date()), 20000);
		return () => clearInterval(timer);
	});

	onDestroy(() => clearInterval(timer));
</script>

{#if active}
	<div class="frame-stage">
		<div class="phone" aria-label="Android APK frame preview">
			<div class="phone-screen">
				<div class="phone-aurora" aria-hidden="true"></div>
				<div class="phone-status">
					<span>{clockHHMM(now)}</span>
					<span class="status-right">
						<svg width="11" height="9" viewBox="0 0 16 12" fill="currentColor" aria-hidden="true">
							<rect x="0" y="8" width="3" height="4" rx="0.7" />
							<rect x="4.3" y="5.6" width="3" height="6.4" rx="0.7" />
							<rect x="8.6" y="3" width="3" height="9" rx="0.7" />
							<rect x="12.9" y="0" width="3" height="12" rx="0.7" opacity="0.45" />
						</svg>
						<svg width="12" height="9" viewBox="0 0 16 12" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
							<path d="M1 4.2A10 10 0 0115 4.2" stroke-linecap="round" />
							<path d="M3.6 7A6.6 6.6 0 0112.4 7" stroke-linecap="round" />
							<circle cx="8" cy="10.2" r="1.1" fill="currentColor" stroke="none" />
						</svg>
						<span class="batt">
							<i></i>
						</span>
						87%
					</span>
				</div>
				<slot />
				<div class="phone-home" aria-hidden="true"></div>
			</div>
			<div class="phone-glare" aria-hidden="true"></div>
		</div>
		<div class="frame-note">
			APK frame preview · 402 × 872 dp · safe-area aware · {$syncState.queued} queued · {isoDay(now)}
		</div>
	</div>
{:else}
	<div class="app-host">
		<slot />
	</div>
{/if}

<style>
	.phone-aurora {
		position: absolute;
		inset: 0;
		z-index: 0;
		background:
			radial-gradient(80% 60% at 18% 6%, color-mix(in srgb, var(--blob-a) 26%, transparent), transparent 62%),
			radial-gradient(70% 55% at 88% 12%, color-mix(in srgb, var(--blob-c) 20%, transparent), transparent 66%),
			radial-gradient(90% 60% at 50% 104%, color-mix(in srgb, var(--blob-b) 22%, transparent), transparent 64%),
			var(--bg-0);
		pointer-events: none;
	}

	.phone-status {
		mix-blend-mode: normal;
	}

	.status-right {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}

	.batt {
		width: 17px;
		height: 9px;
		border: 1px solid currentColor;
		border-radius: 2.6px;
		position: relative;
		display: inline-flex;
		align-items: center;
		padding: 1px;
		opacity: 0.9;
	}

	.batt::after {
		content: '';
		position: absolute;
		right: -3px;
		top: 2.4px;
		width: 1.6px;
		height: 3.4px;
		border-radius: 0 1px 1px 0;
		background: currentColor;
		opacity: 0.75;
	}

	.batt i {
		display: block;
		width: 78%;
		height: 100%;
		border-radius: 1.4px;
		background: currentColor;
	}

	.phone-home {
		position: absolute;
		left: 50%;
		bottom: 7px;
		transform: translateX(-50%);
		width: 128px;
		height: 4px;
		border-radius: 3px;
		background: color-mix(in srgb, var(--text) 42%, transparent);
		z-index: 8;
		pointer-events: none;
	}

	/* nudge content away from the home indicator */
	:global(.phone-screen .app-shell) {
		padding-bottom: 14px;
	}

	:global(.phone-screen .workstation) {
		padding-bottom: 96px;
	}

	:global(.phone-screen .frame-note) {
		display: none;
	}
</style>
