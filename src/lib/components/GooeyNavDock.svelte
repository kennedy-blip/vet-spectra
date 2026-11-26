<script>
	import { onDestroy, onMount } from 'svelte';
	import { spring } from 'svelte/motion';
	import { activeModule, goToModule, MODULES } from '$lib/stores/vetStore.js';

	// Elastic gooey indicator — stiffness / damping tuned for a viscous clinical feel.
	const indicator = spring(
		{ left: 6, width: 96 },
		{ stiffness: 0.18, damping: 0.68 }
	);

	let dockEl = null;
	let buttons = [];

	function measure() {
		if (!dockEl || !buttons.length) return;
		const index = MODULES.findIndex((m) => m.key === $activeModule);
		const btn = buttons[index];
		if (!btn) return;
		const dockRect = dockEl.getBoundingClientRect();
		const rect = btn.getBoundingClientRect();
		indicator.set({ left: rect.left - dockRect.left, width: rect.width });
	}

	$: if ($activeModule && dockEl) {
		// Re-measure whenever the active module changes.
		void $activeModule;
		queueMicrotask(measure);
	}

	let ro = null;
	onMount(() => {
		measure();
		const t = setTimeout(measure, 90);
		if (typeof ResizeObserver !== 'undefined' && dockEl) {
			ro = new ResizeObserver(() => measure());
			ro.observe(dockEl);
		}
		window.addEventListener('resize', measure);
		return () => {
			clearTimeout(t);
			window.removeEventListener('resize', measure);
		};
	});

	onDestroy(() => {
		ro?.disconnect();
	});

	function select(key) {
		goToModule(key);
		setTimeout(measure, 30);
	}
</script>

<div class="dock-wrap">
	<div class="dock" bind:this={dockEl} role="tablist" aria-label="Diagnostic workstations">
		<div
			class="dock-glow"
			style={`transform: translateX(${$indicator.left}px); width: ${$indicator.width}px;`}
			aria-hidden="true"
		></div>
		{#each MODULES as m, i}
			<button
				class="dock-btn"
				class:active={$activeModule === m.key}
				role="tab"
				aria-selected={$activeModule === m.key}
				title={`${m.index}. ${m.title}`}
				on:click={() => select(m.key)}
				bind:this={buttons[i]}
			>
				<span class="dock-num">{String(m.index).padStart(2, '0')}</span>
				<span class="dock-icon" aria-hidden="true">{m.icon}</span>
				<span class="dock-label">{m.label}</span>
			</button>
		{/each}
	</div>
</div>

<style>
	.dock-glow {
		position: absolute;
		top: 6px;
		left: 0;
		height: calc(100% - 12px);
		border-radius: 15px;
		background: linear-gradient(
			135deg,
			color-mix(in srgb, var(--teal) 92%, #ffffff 6%),
			color-mix(in srgb, var(--cyan) 68%, var(--teal))
		);
		box-shadow: 0 0 26px -4px var(--teal), inset 0 1px 0 rgba(255, 255, 255, 0.45);
		z-index: 0;
		pointer-events: none;
	}

	.dock-btn {
		position: relative;
		z-index: 1;
	}

	.dock-icon {
		font-size: 12px;
		line-height: 1;
	}

	.dock-btn.active .dock-icon {
		filter: drop-shadow(0 0 3px rgba(0, 20, 14, 0.6));
	}

	[data-theme='eco'] .dock-glow {
		box-shadow: none;
	}
</style>
