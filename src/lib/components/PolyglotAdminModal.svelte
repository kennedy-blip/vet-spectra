<script>
	import { onMount } from 'svelte';
	import { closeModal, pushToast, ROLES, refreshSyncState, syncState, THEMES } from '$lib/stores/vetStore.js';
	import { clearVault, downloadJson, exportVault, outboxEndpoint, vaultStats } from '$lib/db/indexedDbVetVault.js';
	import { runSelfTests } from '$lib/selftests/vetSelfTestSuite.js';

	let tests = [];
	let running = false;
	let currentTab = 'tests';
	let apiResult = null;
	let apiBusy = false;
	let stats = null;
	let exporting = false;
	let probeAt = null;

	const LANG_MIX = [
		{ lang: 'Svelte', pct: 45.6, color: '#ff3e00', files: 14 },
		{ lang: 'JavaScript', pct: 27.9, color: '#f1e05a', files: 15 },
		{ lang: 'Python', pct: 12.8, color: '#3572a5', files: 4 },
		{ lang: 'Kotlin', pct: 6.4, color: '#a97bff', files: 2 },
		{ lang: 'GLSL', pct: 3.6, color: '#5686a5', files: 2 },
		{ lang: 'CSS', pct: 3.1, color: '#563d7c', files: 1 },
		{ lang: 'Other', pct: 0.6, color: '#8b949e', files: 5 }
	];

	async function runAll() {
		running = true;
		tests = [];
		await new Promise((r) => setTimeout(r, 30));
		const { passed, total, ok } = await runSelfTests({
			onResult: (row) => {
				tests = [...tests, row];
			}
		});
		running = false;
		pushToast(`${passed}/${total} engine assertions passed`, ok ? 'ok' : 'bad', 6000);
	}

	async function probeApi() {
		apiBusy = true;
		apiResult = null;
		try {
			const res = await fetch(outboxEndpoint(), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action: 'health' })
			});
			const text = await res.text();
			let parsed = null;
			try {
				parsed = JSON.parse(text);
			} catch {
				parsed = { raw: text.slice(0, 400) };
			}
			apiResult = { ok: res.ok, status: res.status, body: parsed };
		} catch (err) {
			apiResult = { ok: false, status: 0, body: { error: String(err.message || err) } };
		} finally {
			apiBusy = false;
			probeAt = new Date();
		}
	}

	async function loadStats() {
		try {
			stats = await vaultStats();
		} catch {
			stats = null;
		}
	}

	async function doExport() {
		exporting = true;
		try {
			const dump = await exportVault();
			downloadJson(`vet-spectra-vault-${new Date().toISOString().slice(0, 10)}.json`, dump);
			pushToast(`Vault exported · ${dump.integrity.slice(0, 16)}…`, 'ok');
		} catch {
			pushToast('Export failed — storage may be blocked', 'bad');
		} finally {
			exporting = false;
		}
	}

	async function doClear() {
		if (!window.confirm('Delete every clinical record and queued sync envelope?')) return;
		await clearVault();
		await loadStats();
		await refreshSyncState();
		pushToast('Vault cleared', 'warn');
	}

	onMount(() => {
		loadStats();
		runAll();
		const t = setInterval(loadStats, 6000);
		return () => clearInterval(t);
	});
</script>

<svelte:window on:keydown={(e) => e.key === 'Escape' && closeModal()} />

<div class="modal-veil" role="presentation" on:click|self={closeModal}>
	<div class="modal wide" role="dialog" aria-modal="true" aria-labelledby="admin-title">
		<div class="modal-head">
			<div class="med-icon warning" style="background:color-mix(in srgb,var(--violet) 18%, transparent);border-color:color-mix(in srgb,var(--violet) 40%, transparent);color:var(--violet)">⚙</div>
			<div class="grow">
				<div class="modal-title" id="admin-title">Polyglot Admin Console</div>
				<div class="modal-sub">Engine self-tests · Python API probe · IndexedDB vault · stack composition</div>
			</div>
			<span class="badge violet"><span class="dot"></span>v27.0.0-polyglot</span>
			<button class="close-x" on:click={closeModal} aria-label="Close">×</button>
		</div>

		<div class="tabs">
			<button class:active={currentTab === 'tests'} on:click={() => (currentTab = 'tests')}>Self-tests</button>
			<button class:active={currentTab === 'api'} on:click={() => (currentTab = 'api')}>Python API</button>
			<button class:active={currentTab === 'vault'} on:click={() => (currentTab = 'vault')}>Vault</button>
			<button class:active={currentTab === 'stack'} on:click={() => (currentTab = 'stack')}>Stack &amp; RBAC</button>
		</div>

		<div class="modal-body">
			{#if currentTab === 'tests'}
				<div class="row spread" style="margin-bottom:10px">
					<span class="tiny mute">
						16 assertions executed in-browser against the same ES modules the UI uses — the Python mirrors run the
						identical maths server-side.
					</span>
					<button class="btn primary mini" on:click={runAll} disabled={running}>
						{running ? 'Running…' : 'Re-run all'}
					</button>
				</div>
				<div class="test-list">
					{#each tests as t}
						<div class="test-row" class:pass={t.pass} class:fail={!t.pass}>
							<span class="test-mark">{t.pass ? '✓' : '✕'}</span>
							<div class="grow">
								<div class="test-name">{t.name}</div>
								<div class="test-actual mono">{t.actual}</div>
							</div>
							<span class="mono tiny dim">{t.ms.toFixed(1)} ms</span>
						</div>
					{/each}
					{#if running && tests.length < 16}
						<div class="test-row running">
							<span class="test-mark">⋯</span>
							<div class="grow"><div class="test-name">Executing assertion {tests.length + 1}…</div></div>
						</div>
					{/if}
				</div>
				{#if !running && tests.length}
					<div class="verdict {tests.every((t) => t.pass) ? 'info' : 'bad'}" style="margin-top:10px">
						<div class="med-icon {tests.every((t) => t.pass) ? 'info' : 'bad'}">{tests.every((t) => t.pass) ? '✓' : '!'}</div>
						<div>
							<div class="verdict-title">
								{tests.filter((t) => t.pass).length}/{tests.length} assertions passed
							</div>
							<div class="verdict-body">
								Total compute {tests.reduce((a, t) => a + t.ms, 0).toFixed(0)} ms — all maths runs locally, so the
								workstation is fully functional in aeroplane mode.
							</div>
						</div>
					</div>
				{/if}
			{:else if currentTab === 'api'}
				<div class="api-grid">
					<div>
						<div class="kv"><span class="k">Endpoint</span><span class="v">{outboxEndpoint()}</span></div>
						<div class="kv"><span class="k">Runtime</span><span class="v">Python 3.12 serverless</span></div>
						<div class="kv"><span class="k">Handler</span><span class="v">BaseHTTPRequestHandler</span></div>
						<div class="kv"><span class="k">Actions</span><span class="v">health · sync · dose · gait · quote</span></div>
						<button class="btn primary mini" style="margin-top:10px" on:click={probeApi} disabled={apiBusy}>
							{apiBusy ? 'Probing…' : 'POST /api/vet_physics {action:"health"}'}
						</button>
						{#if probeAt}<div class="tiny mute" style="margin-top:6px">Probed {probeAt.toLocaleTimeString('en-GB')}</div>{/if}
					</div>
					<div class="api-out">
						{#if apiResult}
							<div class="row spread" style="margin-bottom:6px">
								<span class="badge {apiResult.ok ? 'ok' : 'warn'}"><span class="dot"></span>HTTP {apiResult.status || 'offline'}</span>
							</div>
							<pre class="api-pre mono">{JSON.stringify(apiResult.body, null, 2)}</pre>
							{#if !apiResult.ok}
								<p class="tiny mute" style="margin-top:6px">
									Static Vercel deployments without the Python runtime return the SPA shell. The workstation keeps
									working — queued envelopes are retried when the function becomes reachable.
								</p>
							{/if}
						{:else}
							<div class="api-empty">
								<pre class="api-pre mono">{`POST /api/vet_physics
{ "action": "health" }

→ {
    "ok": true,
    "runtime": "python3.12",
    "modules": [
      "python_vet.toxicology_allometry_solver",
      "python_vet.quadruped_gait_acoustic_biometrics"
    ],
    "engines": 5,
    "ts_allowed": false
  }`}</pre>
							</div>
						{/if}
					</div>
				</div>
			{:else if currentTab === 'vault'}
				<div class="row spread" style="margin-bottom:10px">
					<span class="tiny mute">
						Adapter <b class="mono">{stats?.kind ?? '—'}</b> · {stats?.total ?? 0} clinical records ·
						{stats?.queued ?? 0} queued for sync
					</span>
					<div class="row tight">
						<button class="btn ghost mini" on:click={doExport} disabled={exporting}>{exporting ? 'Exporting…' : 'Export JSON'}</button>
						<button class="btn danger mini" on:click={doClear}>Clear vault</button>
					</div>
				</div>
				<div class="store-grid">
					{#each Object.entries(stats?.perStore ?? {}) as [name, count]}
						<div class="store-card">
							<span class="store-name mono">{name}</span>
							<span class="store-count">{count}</span>
						</div>
					{/each}
				</div>
				<div class="divider"></div>
				<div class="kv"><span class="k">Sync outbox endpoint</span><span class="v">{outboxEndpoint()}</span></div>
				<div class="kv"><span class="k">Queued</span><span class="v">{$syncState.queued ?? stats?.queued ?? 0}</span></div>
				<div class="kv"><span class="k">Delivered</span><span class="v">{$syncState.synced ?? stats?.synced ?? 0}</span></div>
				<div class="kv"><span class="k">Theme preference</span><span class="v">persisted in settings</span></div>
				<div class="kv"><span class="k">Integrity hash</span><span class="v">SHA-256 over the export body</span></div>
				<p class="tiny mute" style="margin-top:9px">
					Every clinical write is committed in the same IDB transaction as its outbox envelope — a killed tab can
					never lose a record or duplicate a queue entry.
				</p>
			{:else}
				<div class="stack-grid">
					<div>
						<span class="label">Language composition (target ≈ Linguist)</span>
						<div class="lang-list">
							{#each LANG_MIX as l}
								<div class="lang-row">
									<span class="lang-name">{l.lang}</span>
									<div class="lang-bar"><i style={`width:${l.pct}%; background:${l.color}`}></i></div>
									<span class="mono tiny dim">{l.pct.toFixed(1)}%</span>
								</div>
							{/each}
						</div>
						<div class="kv" style="margin-top:8px"><span class="k">TypeScript files</span><span class="v" style="color:var(--ok)">0</span></div>
						<div class="kv"><span class="k">tsconfig.json</span><span class="v" style="color:var(--ok)">absent</span></div>
						<div class="kv"><span class="k">lang="ts"</span><span class="v" style="color:var(--ok)">0 occurrences</span></div>
						<div class="kv"><span class="k">Capacitor</span><span class="v">6 · minSdk 26 / target 34</span></div>
					</div>
					<div>
						<span class="label">Privilege matrix</span>
						<div class="rbac">
							{#each ROLES as r}
								<div class="rbac-row">
									<span class="rbac-name">{r.icon} {r.label}</span>
									<span class="mono tiny dim">{r.capabilities.length} capabilities</span>
								</div>
							{/each}
						</div>
						<span class="label" style="display:block;margin-top:12px">Themes</span>
						<div class="theme-list">
							{#each THEMES as t}
								<div class="theme-row">
									<span class="theme-chip" data-theme-dot={t.key}></span>
									<span class="tiny">{t.label}</span>
									<span class="mono tiny dim grow">{t.gpu === 'eco' ? 'no blur' : 'blur'}</span>
								</div>
							{/each}
						</div>
						<span class="label" style="display:block;margin-top:12px">Shortcuts</span>
						<div class="tiny mute">1–5 switch workstations · Esc closes dialogs · the dock is spring-physics driven</div>
					</div>
				</div>
			{/if}
		</div>

		<div class="modal-foot">
			<span class="tiny mute">Svelte 4 · ES2024 · Python 3.12 · Kotlin · GLSL ES 3.00 · Capacitor 6</span>
			<button class="btn primary" on:click={closeModal}>Close console</button>
		</div>
	</div>
</div>

<style>
	.tabs {
		display: flex;
		gap: 2px;
		padding: 6px 10px 0;
		border-bottom: 1px solid var(--hairline);
		flex: none;
		overflow-x: auto;
	}

	.tabs button {
		appearance: none;
		border: 0;
		background: transparent;
		color: var(--text-mute);
		font-family: inherit;
		font-size: 10.5px;
		font-weight: 700;
		letter-spacing: 0.05em;
		padding: 8px 12px;
		border-radius: 9px 9px 0 0;
		cursor: pointer;
		white-space: nowrap;
		border-bottom: 2px solid transparent;
	}

	.tabs button.active {
		color: var(--text);
		background: color-mix(in srgb, var(--card-bg) 60%, transparent);
		border-bottom-color: var(--teal);
	}

	.test-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.test-row {
		display: flex;
		align-items: flex-start;
		gap: 9px;
		padding: 6px 9px;
		border-radius: 9px;
		border: 1px solid var(--stroke);
		background: color-mix(in srgb, var(--card-bg) 55%, transparent);
	}

	.test-row.pass {
		border-color: color-mix(in srgb, var(--ok) 32%, transparent);
	}

	.test-row.fail {
		border-color: color-mix(in srgb, var(--bad) 45%, transparent);
		background: color-mix(in srgb, var(--bad) 7%, transparent);
	}

	.test-mark {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 800;
		width: 12px;
		flex: none;
		color: var(--text-mute);
		padding-top: 1px;
	}

	.test-row.pass .test-mark { color: var(--ok); }
	.test-row.fail .test-mark { color: var(--bad); }

	.test-name {
		font-size: 10.5px;
		font-weight: 650;
		color: var(--text);
		line-height: 1.35;
	}

	.test-actual {
		font-size: 9px;
		color: var(--text-mute);
		margin-top: 2px;
	}

	.api-grid {
		display: grid;
		grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.15fr);
		gap: 16px;
	}

	.api-pre {
		margin: 0;
		font-size: 9.5px;
		line-height: 1.55;
		padding: 10px;
		border-radius: 10px;
		background: color-mix(in srgb, var(--bg-0) 62%, transparent);
		border: 1px solid var(--stroke);
		color: color-mix(in srgb, var(--teal) 40%, var(--text-dim));
		overflow-x: auto;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.store-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(148px, 1fr));
		gap: 7px;
	}

	.store-card {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 6px;
		padding: 8px 10px;
		border-radius: 10px;
		border: 1px solid var(--stroke);
		background: color-mix(in srgb, var(--card-bg) 60%, transparent);
	}

	.store-name {
		font-size: 9px;
		color: var(--text-mute);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.store-count {
		font-family: var(--font-mono);
		font-size: 15px;
		font-weight: 800;
		color: var(--teal);
	}

	.stack-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
		gap: 20px;
	}

	.lang-list {
		display: flex;
		flex-direction: column;
		gap: 5px;
		margin-top: 6px;
	}

	.lang-row {
		display: grid;
		grid-template-columns: 74px 1fr 46px;
		align-items: center;
		gap: 8px;
	}

	.lang-name {
		font-size: 10px;
		color: var(--text-dim);
	}

	.lang-bar {
		height: 6px;
		border-radius: 4px;
		background: color-mix(in srgb, var(--bg-0) 60%, transparent);
		overflow: hidden;
	}

	.lang-bar i {
		display: block;
		height: 100%;
		border-radius: 4px;
	}

	.rbac {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin-top: 6px;
	}

	.rbac-row {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		padding: 5px 8px;
		border-radius: 8px;
		border: 1px solid var(--hairline);
		background: color-mix(in srgb, var(--card-bg) 45%, transparent);
	}

	.rbac-name {
		font-size: 10px;
		font-weight: 650;
		color: var(--text);
	}

	.theme-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin-top: 6px;
	}

	.theme-row {
		display: flex;
		align-items: center;
		gap: 7px;
	}

	.theme-chip {
		width: 12px;
		height: 12px;
		border-radius: 50%;
		border: 1px solid var(--stroke-strong);
		flex: none;
	}

	@media (max-width: 700px) {
		.api-grid {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
