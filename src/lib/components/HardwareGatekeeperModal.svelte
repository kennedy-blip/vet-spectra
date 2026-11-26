<script>
	import { onMount } from 'svelte';
	import { can, closeModal, permissions, pushToast, role, setPermission } from '$lib/stores/vetStore.js';
	import { probeWebGl } from '$lib/gl/vetGl.js';
	import { isIndexedDbAvailable } from '$lib/db/indexedDbVetVault.js';

	let env = {
		webgl2: false,
		renderer: 'probing',
		maxTexture: 0,
		secure: true,
		idb: false,
		audio: false,
		microphones: 0,
		dpr: 1,
		ua: ''
	};

	let busyKey = null;

	const SENSORS = [
		{
			key: 'mic',
			label: 'Microphone · raw acoustic',
			capability: 'hardware.mic',
			detail: '48 kHz unprocessed capture for the bio-acoustic airway lab (spectrogram, CPP, BOAS grading). No audio ever leaves the device.',
			icon: '◉'
		},
		{
			key: 'camera',
			label: 'Camera · macro lens',
			capability: 'hardware.camera',
			detail: 'Rear-camera macro frames for scutal-index caliper measurement, gingival CIELAB sampling and the ring-light torch plugin.',
			icon: '◎'
		},
		{
			key: 'imu',
			label: 'IMU · 120 Hz harness',
			capability: 'hardware.imu',
			detail: 'Device-motion accelerometry for head-nod / pelvic-hike gait harmonics and the seismocardiogram thrill RMS.',
			icon: '⌁'
		},
		{
			key: 'haptics',
			label: 'Haptics · alarm pulse',
			capability: 'hardware.haptics',
			detail: 'Vibration patterns for critical toxicity zones and SRR breaches when the screen is not being watched.',
			icon: '≈'
		}
	];

	onMount(async () => {
		const probe = probeWebGl();
		env = {
			...env,
			webgl2: probe.webgl2,
			renderer: probe.renderer,
			maxTexture: probe.maxTexture,
			secure: typeof window !== 'undefined' ? window.isSecureContext : false,
			idb: isIndexedDbAvailable(),
			audio: typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext),
			dpr: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
			ua: typeof navigator !== 'undefined' ? navigator.userAgent : 'ssr'
		};
		try {
			if (navigator.mediaDevices?.enumerateDevices) {
				const devices = await navigator.mediaDevices.enumerateDevices();
				env = { ...env, microphones: devices.filter((d) => d.kind === 'audioinput').length };
			}
		} catch {
			/* enumerateDevices is gated behind a user gesture on some browsers */
		}
	});

	const statusTone = (s) => (s === 'granted' ? 'ok' : s === 'denied' ? 'bad' : s === 'simulated' ? 'violet' : 'info');
	const statusLabel = (s) =>
		s === 'granted' ? 'Live' : s === 'denied' ? 'Blocked' : s === 'simulated' ? 'Simulated' : 'Idle';

	async function requestMic() {
		if (!can('hardware.mic')) return pushToast('Microphone access requires the Vet Tech tier', 'warn');
		busyKey = 'mic';
		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
			});
			stream.getTracks().forEach((t) => t.stop());
			setPermission('mic', 'granted');
			pushToast('Microphone granted — 48 kHz raw capture armed', 'ok');
		} catch {
			setPermission('mic', 'denied');
			pushToast('Microphone blocked — use the 1-tap simulator', 'warn');
		} finally {
			busyKey = null;
		}
	}

	async function requestCamera() {
		if (!can('hardware.camera')) return pushToast('Camera access requires the Vet Tech tier', 'warn');
		busyKey = 'camera';
		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }
			});
			stream.getTracks().forEach((t) => t.stop());
			setPermission('camera', 'granted');
			pushToast('Camera granted — macro lens armed', 'ok');
		} catch {
			setPermission('camera', 'denied');
			pushToast('Camera blocked — the procedural specimen viewer stays available', 'warn');
		} finally {
			busyKey = null;
		}
	}

	async function requestImu() {
		if (!can('hardware.imu')) return pushToast('IMU access requires the Vet Tech tier', 'warn');
		busyKey = 'imu';
		try {
			const DOE = window.DeviceOrientationEvent;
			const DME = window.DeviceMotionEvent;
			if (!DOE && !DME) {
				setPermission('imu', 'simulated');
				pushToast('No motion sensors exposed — gait simulator enabled', 'warn');
				return;
			}
			if (typeof DME?.requestPermission === 'function') {
				const res = await DME.requestPermission();
				if (res !== 'granted') throw new Error('denied');
			}
			setPermission('imu', 'granted');
			pushToast('IMU granted — 120 Hz harness arm-able', 'ok');
		} catch {
			setPermission('imu', 'denied');
			pushToast('IMU denied — 1-tap gait simulator remains available', 'warn');
		} finally {
			busyKey = null;
		}
	}

	async function requestHaptics() {
		busyKey = 'haptics';
		try {
			if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
				navigator.vibrate([40, 60, 40]);
				setPermission('haptics', 'granted');
				pushToast('Haptic alarm pulse armed', 'ok');
			} else {
				setPermission('haptics', 'simulated');
				pushToast('No vibration motor — visual alarm flash substituted', 'warn');
			}
		} finally {
			busyKey = null;
		}
	}

	function simulateAll() {
		for (const s of SENSORS) {
			if ($permissions[s.key] !== 'granted') setPermission(s.key, 'simulated');
		}
		pushToast('All sensors in simulation mode — every module stays fully operable', 'ok');
	}

	const handlers = { mic: requestMic, camera: requestCamera, imu: requestImu, haptics: requestHaptics };
</script>

<svelte:window on:keydown={(e) => e.key === 'Escape' && closeModal()} />

<div class="modal-veil" role="presentation" on:click|self={closeModal}>
	<div class="modal" role="dialog" aria-modal="true" aria-labelledby="hw-title">
		<div class="modal-head">
			<div class="med-icon info" aria-hidden="true">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
					<path d="M12 3l7 3v5.4c0 4.6-3.1 7.6-7 9.1-3.9-1.5-7-4.5-7-9.1V6z" stroke-linejoin="round" />
					<path d="M9.4 12.2l1.9 1.9 3.4-3.6" stroke-linecap="round" stroke-linejoin="round" />
				</svg>
			</div>
			<div class="grow">
				<div class="modal-title" id="hw-title">Hardware Gatekeeper</div>
				<div class="modal-sub">Explicit, per-sensor consent · current tier: {$role === 'guardian' ? 'Guardian (read-only)' : $role === 'tech' ? 'Vet Tech' : 'Veterinarian'}</div>
			</div>
			<button class="close-x" on:click={closeModal} aria-label="Close">×</button>
		</div>

		<div class="modal-body">
			<div class="sensor-list">
				{#each SENSORS as s}
					<div class="sensor-row" class:on={$permissions[s.key] === 'granted'}>
						<div class="sensor-icon" aria-hidden="true">{s.icon}</div>
						<div class="grow">
							<div class="row spread">
								<span class="sensor-label">{s.label}</span>
								<span class="badge {statusTone($permissions[s.key])}">
									<span class="dot"></span>{statusLabel($permissions[s.key])}
								</span>
							</div>
							<div class="sensor-detail">{s.detail}</div>
						</div>
						<button
							class="btn mini"
							class:primary={$permissions[s.key] !== 'granted'}
							disabled={busyKey === s.key}
							on:click={handlers[s.key]}
						>
							{busyKey === s.key ? '…' : $permissions[s.key] === 'granted' ? 'Re-test' : can(s.capability) ? 'Request' : 'Locked'}
						</button>
					</div>
				{/each}
			</div>

			<div class="divider"></div>

			<div class="env-grid">
				<div class="kv"><span class="k">WebGL2</span><span class="v" class:teal={env.webgl2} class:coral={!env.webgl2}>{env.webgl2 ? 'available' : 'fallback CSS'}</span></div>
				<div class="kv"><span class="k">GPU renderer</span><span class="v env-ellipsis" title={env.renderer}>{env.renderer}</span></div>
				<div class="kv"><span class="k">Max texture</span><span class="v">{env.maxTexture || '—'}</span></div>
				<div class="kv"><span class="k">IndexedDB</span><span class="v" class:teal={env.idb} class:amber={!env.idb}>{env.idb ? 'persistent' : 'memory fallback'}</span></div>
				<div class="kv"><span class="k">AudioContext</span><span class="v" class:teal={env.audio} class:coral={!env.audio}>{env.audio ? 'ready' : 'unavailable'}</span></div>
				<div class="kv"><span class="k">Secure context</span><span class="v" class:teal={env.secure} class:amber={!env.secure}>{env.secure ? 'yes' : 'no'}</span></div>
				<div class="kv"><span class="k">Input devices</span><span class="v">{env.microphones} mic{env.microphones === 1 ? '' : 's'}</span></div>
				<div class="kv"><span class="k">DPR</span><span class="v">{env.dpr.toFixed(2)}×</span></div>
			</div>

			{#if !env.webgl2}
				<div class="verdict warn" style="margin-top:12px">
					<div class="med-icon warn">!</div>
					<div>
						<div class="verdict-title">Eco-Glass recommended</div>
						<div class="verdict-body">WebGL2 is unavailable, so the living-glass underlay and the macro lens fall back to CSS gradients and Canvas2D. Switch to <b>Eco-Glass</b> in the theme selector for the lowest-power experience.</div>
					</div>
				</div>
			{/if}

			<div class="perm-note">
				Permissions are requested only on the button press and are never used for background capture. Denying a sensor never disables a module — each one has a deterministic 1-tap simulator so the maths always runs.
			</div>
		</div>

		<div class="modal-foot">
			<button class="btn ghost mini" on:click={simulateAll}>Simulate all sensors</button>
			<div class="row tight">
				<span class="tiny mute">Tier capabilities: {can('vault.write') ? 'write' : 'read-only'} · {can('vault.export') ? 'export' : 'no export'}</span>
				<button class="btn primary" on:click={closeModal}>Done</button>
			</div>
		</div>
	</div>
</div>

<style>
	.sensor-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.sensor-row {
		display: flex;
		align-items: flex-start;
		gap: 11px;
		padding: 10px 11px;
		border-radius: 12px;
		border: 1px solid var(--stroke);
		background: color-mix(in srgb, var(--card-bg) 62%, transparent);
		transition: border-color 0.25s ease, background 0.25s ease;
	}

	.sensor-row.on {
		border-color: color-mix(in srgb, var(--teal) 42%, transparent);
		background: color-mix(in srgb, var(--teal) 8%, transparent);
	}

	.sensor-icon {
		width: 30px;
		height: 30px;
		border-radius: 9px;
		display: grid;
		place-items: center;
		flex: none;
		font-size: 13px;
		color: var(--cyan);
		background: color-mix(in srgb, var(--cyan) 12%, transparent);
		border: 1px solid color-mix(in srgb, var(--cyan) 30%, transparent);
	}

	.sensor-label {
		font-size: 11.5px;
		font-weight: 700;
		color: var(--text);
	}

	.sensor-detail {
		font-size: 10px;
		line-height: 1.5;
		color: var(--text-mute);
		margin-top: 3px;
		max-width: 62ch;
	}

	.env-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
		gap: 0 18px;
	}

	.env-ellipsis {
		max-width: 130px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.perm-note {
		margin-top: 12px;
		font-size: 10px;
		line-height: 1.55;
		color: var(--text-mute);
		padding: 9px 11px;
		border-radius: 10px;
		border: 1px dashed var(--stroke);
	}
</style>
