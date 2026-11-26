<script>
	import {
		can,
		isOnline,
		openModal,
		persistRole,
		persistTheme,
		persistViewMode,
		role,
		ROLES,
		syncState,
		theme,
		THEMES,
		triggerSync,
		viewMode
	} from '$lib/stores/vetStore.js';

	$: activeRole = ROLES.find((r) => r.key === $role) || ROLES[0];
	$: syncLabel = $syncState.busy
		? 'syncing…'
		: $syncState.queued > 0
		? `${$syncState.queued} queued`
		: $syncState.synced > 0
		? `${$syncState.synced} synced`
		: 'vault ready';
</script>

<header class="header-bar deck" aria-label="Workstation header">
	<div class="brand">
		<div class="brand-mark" aria-hidden="true">
			<svg width="19" height="19" viewBox="0 0 24 24" fill="none">
				<path
					d="M12 2.5l8 4.2v6.1c0 5.3-4 8.2-8 9.7-4-1.5-8-4.4-8-9.7V6.7z"
					stroke="currentColor"
					stroke-width="1.5"
					stroke-linejoin="round"
					opacity="0.85"
				/>
				<path
					d="M6.6 11.6h2.6l1.4-3.1 2 7 1.3-3.9h3"
					stroke="url(#vetpulse)"
					stroke-width="1.8"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>
				<defs>
					<linearGradient id="vetpulse" x1="0" y1="0" x2="24" y2="24">
						<stop stop-color="#10b981" />
						<stop offset="1" stop-color="#06b6d4" />
					</linearGradient>
				</defs>
			</svg>
		</div>
		<div class="brand-text">
			<div class="brand-name">VET-SPECTRA</div>
			<div class="brand-sub">Tox · Airway · Gait · ACVIM · Tick — v27.0.0</div>
		</div>
	</div>

	<div class="header-spacer"></div>

	<div class="header-cluster">
		<div class="seg role-seg" role="group" aria-label="Privilege tier">
			{#each ROLES as r}
				<button
					class:active={$role === r.key}
					on:click={() => persistRole(r.key)}
					title={`${r.fullLabel} — ${r.blurb}`}
					aria-pressed={$role === r.key}
				>
					<span class="role-icon" aria-hidden="true">{r.icon}</span>
					<span class="role-label hide-sm">{r.label}</span>
				</button>
			{/each}
		</div>

		<div class="theme-dots" role="group" aria-label="Theme">
			{#each THEMES as t}
				<button
					class="theme-dot"
					class:active={$theme === t.key}
					data-theme-dot={t.key}
					title={`${t.label} — ${t.blurb}`}
					aria-label={t.label}
					aria-pressed={$theme === t.key}
					on:click={() => persistTheme(t.key)}
				/>
			{/each}
		</div>

		<button
			class="btn ghost icon"
			title="Hardware permission gatekeeper"
			aria-label="Hardware permissions"
			on:click={() => openModal('gatekeeper')}
		>
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
				<path d="M12 3l7 3v5.4c0 4.6-3.1 7.6-7 9.1-3.9-1.5-7-4.5-7-9.1V6z" stroke-linejoin="round" />
				<path d="M9.4 12.2l1.9 1.9 3.4-3.6" stroke-linecap="round" stroke-linejoin="round" />
			</svg>
		</button>

		<button
			class="btn ghost mini sync-btn"
			class:busy={$syncState.busy}
			title="Replay the offline sync outbox to the Python API"
			on:click={triggerSync}
		>
			<span class="sync-dot" class:offline={!$isOnline} class:pending={$syncState.queued > 0}></span>
			<span class="mono sync-text hide-sm">{syncLabel}</span>
		</button>

		<div class="seg view-seg" role="group" aria-label="Viewport mode">
			<button
				class:active={$viewMode === 'desktop'}
				on:click={() => persistViewMode('desktop')}
				title="Full-screen desktop workstation"
				aria-pressed={$viewMode === 'desktop'}
			>
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<rect x="2.5" y="4" width="19" height="13" rx="2" />
					<path d="M8 21h8" stroke-linecap="round" />
				</svg>
			</button>
			<button
				class:active={$viewMode === 'frame'}
				on:click={() => persistViewMode('frame')}
				title="Mobile APK frame preview"
				aria-pressed={$viewMode === 'frame'}
			>
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<rect x="6.5" y="2.5" width="11" height="19" rx="2.6" />
					<path d="M10.5 5.2h3" stroke-linecap="round" />
				</svg>
			</button>
		</div>

		{#if can('admin.polyglot')}
			<button
				class="btn ghost icon"
				title="Polyglot admin console — stack, API and vault"
				aria-label="Admin console"
				on:click={() => openModal('polyglot')}
			>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
					<circle cx="12" cy="12" r="3.1" />
					<path
						d="M12 2.6v2.4M12 19v2.4M2.6 12h2.4M19 12h2.4M5.4 5.4l1.7 1.7M16.9 16.9l1.7 1.7M18.6 5.4l-1.7 1.7M7.1 16.9l-1.7 1.7"
						stroke-linecap="round"
					/>
				</svg>
			</button>
		{/if}

		<button class="btn apk-btn" on:click={() => openModal('apk')} title="Download the Android APK">
			<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<path d="M12 3v11" stroke-linecap="round" />
				<path d="M7.5 9.6L12 14.2l4.5-4.6" stroke-linecap="round" stroke-linejoin="round" />
				<path d="M4 17.5v1.6A1.9 1.9 0 005.9 21h12.2a1.9 1.9 0 001.9-1.9v-1.6" stroke-linecap="round" />
			</svg>
			<span class="btn-text">Get .APK</span>
		</button>
	</div>
</header>

<style>
	.brand-text {
		min-width: 0;
	}

	.role-icon {
		font-size: 11px;
		line-height: 1;
		opacity: 0.9;
	}

	.sync-btn {
		position: relative;
	}

	.sync-text {
		font-size: 9.5px;
		letter-spacing: 0.04em;
		color: var(--text-mute);
	}

	.sync-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--ok);
		box-shadow: 0 0 9px var(--ok);
		flex: none;
	}

	.sync-dot.pending {
		background: var(--amber);
		box-shadow: 0 0 9px var(--amber);
	}

	.sync-dot.offline {
		background: var(--text-mute);
		box-shadow: none;
	}

	.sync-btn.busy .sync-dot {
		animation: sync-pulse 0.9s ease-in-out infinite;
	}

	@keyframes sync-pulse {
		0%, 100% { opacity: 1; transform: scale(1); }
		50% { opacity: 0.35; transform: scale(0.7); }
	}

	@media (max-width: 1180px) {
		.view-seg {
			display: none;
		}
	}

	@media (max-width: 900px) {
		.role-label {
			display: none;
		}
		.theme-dots {
			display: none;
		}
	}

	@media (max-width: 660px) {
		.sync-text {
			display: none;
		}
	}
</style>
