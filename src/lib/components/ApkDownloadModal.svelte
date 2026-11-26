<script>
	import { onMount } from 'svelte';
	import { closeModal, pushToast } from '$lib/stores/vetStore.js';
	import { qrSvg } from '$lib/utils/qrSvg.js';
	import {
		APK_FILENAME,
		APK_ROUTE,
		buildFallbackApk,
		formatSize,
		MIN_SDK,
		PACKAGE_ID,
		sha256Bytes,
		TARGET_SDK,
		VERSION_CODE,
		VERSION_NAME
	} from '$lib/utils/apkBinary.js';

	let status = 'checking'; // checking | remote | fallback
	let apkBytes = null;
	let sha = '';
	let size = 0;
	let entries = [];
	let downloading = false;
	let progress = 0;
	let qr = '';
	let qrTarget = '';
	let errorMsg = '';

	onMount(async () => {
		const origin = typeof window !== 'undefined' ? window.location.origin : 'https://vet-spectra.vercel.app';
		qrTarget = `${origin}${APK_ROUTE}`;
		try {
			qr = qrSvg(qrTarget, { size: 128, margin: 3, dark: '#071018', light: '#f8fafc', title: 'Scan to install VET-SPECTRA' });
		} catch {
			qr = qrSvg(origin, { size: 128, margin: 3, dark: '#071018', light: '#f8fafc', title: 'Scan to open VET-SPECTRA' });
			qrTarget = origin;
		}

		try {
			const res = await fetch(APK_ROUTE, { method: 'HEAD', cache: 'no-store' });
			const type = res.headers.get('content-type') || '';
			if (res.ok && !type.includes('text/html')) {
				status = 'remote';
				size = Number(res.headers.get('content-length') || 0);
				return;
			}
		} catch {
			/* network-less / offline APK: fall through to the replica */
		}

		const built = buildFallbackApk();
		apkBytes = built.bytes;
		entries = built.entries;
		size = built.bytes.length;
		sha = await sha256Bytes(built.bytes);
		status = 'fallback';
	});

	async function ensureBytes() {
		if (apkBytes) return apkBytes;
		const built = buildFallbackApk();
		apkBytes = built.bytes;
		entries = built.entries;
		size = built.bytes.length;
		sha = await sha256Bytes(built.bytes);
		status = 'fallback';
		return apkBytes;
	}

	async function download() {
		if (downloading) return;
		downloading = true;
		progress = 8;
		try {
			if (status === 'remote') {
				const a = document.createElement('a');
				a.href = APK_ROUTE;
				a.download = APK_FILENAME;
				document.body.appendChild(a);
				a.click();
				a.remove();
				progress = 100;
				pushToast('Downloading the Gradle-signed VET-SPECTRA APK', 'ok');
			} else {
				const bytes = await ensureBytes();
				const blob = new Blob([bytes], { type: 'application/vnd.android.package-archive' });
				const url = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = url;
				a.download = APK_FILENAME;
				document.body.appendChild(a);
				a.click();
				a.remove();
				setTimeout(() => URL.revokeObjectURL(url), 8000);
				progress = 100;
				pushToast(`Replica APK written · ${formatSize(size)} · SHA-256 ${sha.slice(0, 12)}…`, 'ok');
			}
		} catch (err) {
			errorMsg = String(err?.message || err);
			pushToast('APK build failed — see the modal for details', 'bad');
		} finally {
			setTimeout(() => {
				downloading = false;
			}, 700);
		}
	}

	async function copyHash() {
		try {
			await navigator.clipboard.writeText(sha || qrTarget);
			pushToast(sha ? 'SHA-256 copied' : 'Download URL copied', 'ok');
		} catch {
			pushToast('Clipboard unavailable — select the hash manually', 'warn');
		}
	}
</script>

<svelte:window on:keydown={(e) => e.key === 'Escape' && closeModal()} />

<div class="modal-veil" role="presentation" on:click|self={closeModal}>
	<div class="modal" role="dialog" aria-modal="true" aria-labelledby="apk-title">
		<div class="modal-head">
			<div class="med-icon info" aria-hidden="true">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<rect x="6.5" y="2.5" width="11" height="19" rx="2.6" />
					<path d="M10.5 5.2h3" stroke-linecap="round" />
				</svg>
			</div>
			<div class="grow">
				<div class="modal-title" id="apk-title">VET-SPECTRA · Android APK</div>
				<div class="modal-sub">Capacitor 6 shell · offline-first · same UI, exactly the same maths</div>
			</div>
			<span class="badge" class:ok={status === 'remote'} class:info={status === 'fallback'} class:warn={status === 'checking'}>
				<span class="dot"></span>
				{status === 'remote' ? 'Gradle artefact' : status === 'fallback' ? 'Replica build' : 'Probing…'}
			</span>
			<button class="close-x" on:click={closeModal} aria-label="Close">×</button>
		</div>

		<div class="modal-body">
			<div class="apk-grid">
				<div class="stack">
					<div class="field">
						<span class="label">Package</span>
						<div class="mono apk-pkg">{PACKAGE_ID}</div>
					</div>
					<div class="metric-grid">
						<div class="metric">
							<span class="k">Version</span>
							<span class="v cyan">{VERSION_NAME}</span>
						</div>
						<div class="metric">
							<span class="k">Version code</span>
							<span class="v">{VERSION_CODE}</span>
						</div>
						<div class="metric">
							<span class="k">min / target SDK</span>
							<span class="v">{MIN_SDK} <small>/ {TARGET_SDK}</small></span>
						</div>
						<div class="metric">
							<span class="k">Payload</span>
							<span class="v teal">{formatSize(size)}</span>
						</div>
					</div>

					<div class="field">
						<span class="label">SHA-256</span>
						<div class="hash-box mono">{sha || '— computing at download —'}</div>
					</div>

					{#if entries.length}
						<div class="field">
							<span class="label">Archive contents</span>
							<div class="entry-list">
								{#each entries as e}
									<div class="entry">
										<span class="mono">{e.name}</span>
										<span class="mono dim">{formatSize(e.size)}</span>
									</div>
								{/each}
							</div>
						</div>
					{/if}

					{#if errorMsg}
						<div class="verdict bad">
							<div class="med-icon bad">!</div>
							<div>
								<div class="verdict-title">Build error</div>
								<div class="verdict-body">{errorMsg}</div>
							</div>
						</div>
					{/if}

					<div class="stack tight">
						<span class="label">Install steps</span>
						<ol class="steps">
							<li><span>01</span> Tap <b>Download APK</b> — the file is generated or streamed, never a 404.</li>
							<li><span>02</span> On Android, allow <b>Install unknown apps</b> for your browser.</li>
							<li><span>03</span> Open the file and confirm the SHA-256 shown above.</li>
							<li><span>04</span> Launch offline: all five workstations, the IndexedDB vault and the sync outbox are bundled.</li>
						</ol>
					</div>
				</div>

				<div class="stack qr-col">
					<div class="qr-box" aria-label="QR code for the APK download URL">{@html qr}</div>
					<div class="tiny mute center qr-caption">
						Scan on the ward tablet<br />
						<span class="mono">{qrTarget.replace(/^https?:\/\//, '')}</span>
					</div>
					<div class="divider"></div>
					<div class="kv"><span class="k">Runtime</span><span class="v">Capacitor 6</span></div>
					<div class="kv"><span class="k">Web layer</span><span class="v">SvelteKit static</span></div>
					<div class="kv"><span class="k">TypeScript</span><span class="v">0.0 %</span></div>
					<div class="kv"><span class="k">Offline model</span><span class="v">IndexedDB + outbox</span></div>
					<div class="kv"><span class="k">Native plugins</span><span class="v">Kotlin × 2</span></div>
					<div class="row tight copy-row">
						<button class="btn ghost mini grow" on:click={copyHash}>Copy {sha ? 'hash' : 'URL'}</button>
					</div>
				</div>
			</div>
		</div>

		<div class="modal-foot">
			<div class="tiny mute">
				Works fully offline · IndexedDB vault · no TypeScript · GLSL ES 3.00
			</div>
			<div class="row tight">
				<button class="btn ghost" on:click={closeModal}>Close</button>
				<button class="btn apk-btn" on:click={download} disabled={downloading}>
					{#if downloading}
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" class="spin">
							<path d="M12 3a9 9 0 109 9" stroke-linecap="round" />
						</svg>
						Building… {progress}%
					{:else}
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M12 3v11" stroke-linecap="round" />
							<path d="M7.5 9.6L12 14.2l4.5-4.6" stroke-linecap="round" stroke-linejoin="round" />
							<path d="M4 17.5v1.6A1.9 1.9 0 005.9 21h12.2a1.9 1.9 0 001.9-1.9v-1.6" stroke-linecap="round" />
						</svg>
						Download APK
					{/if}
				</button>
			</div>
		</div>
	</div>
</div>

<style>
	.apk-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 190px;
		gap: 18px;
	}

	.apk-pkg {
		font-size: 12px;
		padding: 7px 10px;
		border-radius: 9px;
		border: 1px solid var(--stroke);
		background: color-mix(in srgb, var(--bg-0) 45%, transparent);
		color: var(--text);
		overflow-wrap: anywhere;
	}

	.hash-box {
		font-size: 9.5px;
		line-height: 1.55;
		letter-spacing: 0.01em;
		padding: 8px 10px;
		border-radius: 9px;
		border: 1px dashed var(--stroke-strong);
		background: color-mix(in srgb, var(--teal) 6%, transparent);
		color: color-mix(in srgb, var(--teal) 45%, var(--text));
		overflow-wrap: anywhere;
	}

	.entry-list {
		display: flex;
		flex-direction: column;
		gap: 3px;
		max-height: 122px;
		overflow-y: auto;
	}

	.entry {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		font-size: 9.5px;
		color: var(--text-dim);
		padding: 3px 6px;
		border-radius: 6px;
		background: color-mix(in srgb, var(--bg-0) 28%, transparent);
	}

	.entry span:first-child {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.steps {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 5px;
	}

	.steps li {
		display: flex;
		gap: 8px;
		font-size: 10.5px;
		line-height: 1.45;
		color: var(--text-dim);
	}

	.steps li span {
		font-family: var(--font-mono);
		font-size: 9px;
		font-weight: 700;
		color: var(--teal);
		padding-top: 1px;
	}

	.steps b {
		color: var(--text);
	}

	.qr-col {
		align-items: center;
		text-align: center;
	}

	.qr-caption {
		line-height: 1.5;
		overflow-wrap: anywhere;
	}

	.copy-row {
		width: 100%;
	}

	.spin {
		animation: spin 0.9s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (max-width: 620px) {
		.apk-grid {
			grid-template-columns: minmax(0, 1fr);
		}
		.qr-col {
			order: -1;
		}
	}
</style>
