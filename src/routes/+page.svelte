<script>
	import { onDestroy, onMount } from 'svelte';
	import '../app.css';

	import MobileApkFrame from '$lib/components/MobileApkFrame.svelte';
	import HeaderWorkstation from '$lib/components/HeaderWorkstation.svelte';
	import GooeyNavDock from '$lib/components/GooeyNavDock.svelte';
	import ApkDownloadModal from '$lib/components/ApkDownloadModal.svelte';
	import HardwareGatekeeperModal from '$lib/components/HardwareGatekeeperModal.svelte';
	import PolyglotAdminModal from '$lib/components/PolyglotAdminModal.svelte';

	import ToxicologyKineticShield from '$lib/components/modules/ToxicologyKineticShield.svelte';
	import VetBioAcousticLab from '$lib/components/modules/VetBioAcousticLab.svelte';
	import QuadrupedGaitScanner from '$lib/components/modules/QuadrupedGaitScanner.svelte';
	import CardioPulmonaryAcvimLab from '$lib/components/modules/CardioPulmonaryAcvimLab.svelte';
	import TickVectorDermaAuditor from '$lib/components/modules/TickVectorDermaAuditor.svelte';

	import { createUnderlay } from '$lib/gl/vetGl.js';
	import { attachSyncListeners } from '$lib/db/indexedDbVetVault.js';
	import {
		activeModule,
		dismissToast,
		goToModule,
		hydratePreferences,
		isOnline,
		markBooted,
		modal,
		MODULES,
		pushToast,
		refreshSyncState,
		setPermission,
		theme,
		THEMES,
		toasts,
		viewMode,
		vitals
	} from '$lib/stores/vetStore.js';
	import { closeModal } from '$lib/stores/vetStore.js';

	let canvasEl = null;
	let gl = null;
	let detachSync = null;
	let unsubVitals = null;

	$: frameMode = $viewMode === 'frame';
	$: activeMeta = MODULES.find((m) => m.key === $activeModule) || MODULES[0];

	$: if (typeof document !== 'undefined') {
		document.documentElement.setAttribute('data-theme', $theme);
		document.documentElement.setAttribute('data-gpu', THEMES.find((t) => t.key === $theme)?.gpu || 'full');
	}

	function handleKey(event) {
		const tag = event.target?.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable) return;
		if (event.key === 'Escape') {
			closeModal();
			return;
		}
		const n = Number(event.key);
		if (n >= 1 && n <= MODULES.length) {
			goToModule(MODULES[n - 1].key);
		}
	}

	onMount(() => {
		hydratePreferences();
		document.documentElement.setAttribute('data-theme', $theme);

		gl = createUnderlay(canvasEl, {
			onError: (msg) => console.warn('[vet-spectra] underlay:', msg)
		});
		if (gl) {
			gl.setState({
				theme: THEMES.findIndex((t) => t.key === $theme),
				eco: $theme === 'eco' ? 1 : 0,
				hr: $vitals.hr,
				energy: $vitals.energy,
				toxicity: $vitals.toxicity
			});
			gl.start();
		}

		unsubVitals = vitals.subscribe((v) => {
			gl?.setState({ hr: v.hr, energy: v.energy, toxicity: v.toxicity });
		});

		detachSync = attachSyncListeners();
		if (typeof navigator !== 'undefined' && navigator.onLine === false) isOnline.set(false);
		const on = () => isOnline.set(true);
		const off = () => isOnline.set(false);
		window.addEventListener('online', on);
		window.addEventListener('offline', off);

		if (navigator.storage?.persist) {
			navigator.storage.persist().catch(() => {});
		}
		setPermission('storage', 'granted');

		refreshSyncState();
		const interval = setInterval(refreshSyncState, 15000);

		markBooted();
		console.info(
			'%cVET-SPECTRA 27.0.0-polyglot',
			'background:#10b981;color:#04120e;font-weight:700;padding:2px 6px;border-radius:4px',
			'· 0 % TypeScript · Svelte + ES2024 + Python 3.12 + Kotlin + GLSL'
		);
		pushToast('VET-SPECTRA online — 5 workstations, all maths local', 'ok');

		return () => {
			window.removeEventListener('online', on);
			window.removeEventListener('offline', off);
			clearInterval(interval);
			detachSync?.();
			unsubVitals?.();
			gl?.destroy();
		};
	});

	onDestroy(() => {
		gl?.destroy();
		gl = null;
	});
</script>

<svelte:window on:keydown={handleKey} />

<div id="stage" aria-hidden="true"></div>
<canvas id="biovital-canvas" bind:this={canvasEl} aria-hidden="true"></canvas>

<svg class="svg-defs" aria-hidden="true" focusable="false">
	<defs>
		<filter id="vet-gooey-dock" x="-30%" y="-60%" width="160%" height="220%">
			<feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
			<feColorMatrix
				in="blur"
				mode="matrix"
				values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 26 -11"
				result="goo"
			/>
			<feComposite in="SourceGraphic" in2="goo" operator="atop" />
		</filter>
	</defs>
</svg>

<MobileApkFrame active={frameMode}>
	<div
		class="app-shell"
		class:frame-mode={frameMode}
		class:depth-pushed={$modal !== null}
		data-module={$activeModule}
	>
		<HeaderWorkstation />

		<main class="workstation" id="workstation" aria-label={activeMeta.title}>
			{#if $activeModule === 'toxicology'}
				<ToxicologyKineticShield />
			{:else if $activeModule === 'acoustic'}
				<VetBioAcousticLab />
			{:else if $activeModule === 'gait'}
				<QuadrupedGaitScanner />
			{:else if $activeModule === 'cardio'}
				<CardioPulmonaryAcvimLab />
			{:else if $activeModule === 'tick'}
				<TickVectorDermaAuditor />
			{/if}
		</main>

		<GooeyNavDock />
	</div>

	{#if $modal === 'apk'}
		<ApkDownloadModal />
	{:else if $modal === 'gatekeeper'}
		<HardwareGatekeeperModal />
	{:else if $modal === 'polyglot'}
		<PolyglotAdminModal />
	{/if}

	<div class="toast-stack" aria-live="polite">
		{#each $toasts as t (t.id)}
			<button class="toast {t.kind}" on:click={() => dismissToast(t.id)}>{t.message}</button>
		{/each}
	</div>
</MobileApkFrame>

<div class="film-grain" aria-hidden="true"></div>

<style>
	.svg-defs {
		position: fixed;
		width: 0;
		height: 0;
		overflow: hidden;
		pointer-events: none;
	}

	.toast {
		border: 1px solid var(--stroke-strong);
		text-align: left;
		cursor: pointer;
	}
</style>
