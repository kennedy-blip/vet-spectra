<script>
	import { onMount } from 'svelte';
	import {
		bumpVitals,
		can,
		patient,
		permissions,
		pushToast,
		refreshSyncState,
		theme
	} from '$lib/stores/vetStore.js';
	import { saveClinicalRecord } from '$lib/db/indexedDbVetVault.js';
	import {
		ACOUSTIC_SIGNATURES,
		buildWaterfall,
		classifySignature,
		computeBOAS,
		extractFeatures,
		FREQUENCY_LANDMARKS,
		getSignature,
		getAudioContext,
		playSamples,
		SAMPLE_RATE,
		synthesizeSignature
	} from '$lib/engines/vetBioAcousticEngine.js';
	import {
		clamp,
		cssVar,
		drawAxisLabel,
		fmt,
		setupCanvas,
		withAlpha
	} from '$lib/utils/format.js';

	/* ------------------------------------------------------------- state -- */
	let signatureKey = 'kennel_cough';
	let species = 'dog';
	let samples = null;
	let sampleRate = SAMPLE_RATE;
	let features = null;
	let ranked = [];
	let boas = null;
	let wf = null;
	let analysing = false;
	let playing = false;
	let player = null;
	let playhead = 0;
	let playTimer = null;
	let postExercise = false;
	let muted = false;
	let source = 'simulator';
	let capturedSeconds = 0;
	let micState = 'idle';
	let stream = null;
	let captureTimer = null;
	let savedFlash = 0;
	let wfCanvas = null;
	let specCanvas = null;
	let mounted = false;
	let cache = null;
	let cacheToken = 0;

	const DURATION = 3.4;

	$: activeSig = getSignature(signatureKey);
	$: topMatch = ranked[0] ?? null;
	$: boasTone = boas ? (boas.grade >= 2 ? 'bad' : boas.grade === 1 ? 'warn' : 'ok') : 'ok';

	/* ------------------------------------------------------------ helpers -- */
	function spectroColor(v) {
		// nav-like ramp: abyss → deep teal → mint → cyan → amber
		const stops = [
			[0.02, 0.06, 0.09],
			[0.03, 0.24, 0.29],
			[0.06, 0.55, 0.45],
			[0.25, 0.85, 0.8],
			[0.98, 0.9, 0.55]
		];
		const t = clamp(v, 0, 1) * (stops.length - 1);
		const i = Math.min(stops.length - 2, Math.floor(t));
		const f = t - i;
		return [
			stops[i][0] + (stops[i + 1][0] - stops[i][0]) * f,
			stops[i][1] + (stops[i + 1][1] - stops[i][1]) * f,
			stops[i][2] + (stops[i + 1][2] - stops[i][2]) * f
		];
	}

	/* ------------------------------------------------------------- canvas -- */
	function drawWaterfall() {
		if (!wfCanvas) return;
		const setup = setupCanvas(wfCanvas, 210);
		if (!setup) return;
		const { ctx, w, h } = setup;
		const stripH = 40;
		const plotY = stripH + 6;
		const plotH = h - plotY - 16;
		const textMute = cssVar('--text-mute', '#6f8299');
		const cyan = cssVar('--cyan', '#06b6d4');
		const teal = cssVar('--teal', '#10b981');
		const amber = cssVar('--amber', '#f59e0b');

		ctx.clearRect(0, 0, w, h);

		/* ---- waveform strip ---- */
		if (samples) {
			const n = samples.length;
			const step = Math.max(1, Math.floor(n / (w * 2)));
			ctx.beginPath();
			for (let px = 0; px < w; px++) {
				let min = 0;
				let max = 0;
				const start = Math.floor((px / w) * n);
				for (let i = start; i < Math.min(n, start + step); i++) {
					min = Math.min(min, samples[i]);
					max = Math.max(max, samples[i]);
				}
				const y0 = stripH / 2 - max * (stripH / 2 - 2);
				const y1 = stripH / 2 - min * (stripH / 2 - 2);
				ctx.moveTo(px + 0.5, y0);
				ctx.lineTo(px + 0.5, y1);
			}
			ctx.strokeStyle = withAlpha(cyan, 0.72);
			ctx.lineWidth = 1;
			ctx.stroke();
			ctx.fillStyle = withAlpha(textMute, 0.5);
			ctx.fillRect(0, stripH / 2, w, 0.5);
		}

		/* ---- waterfall ---- */
		if (wf) {
			const { rows, bins, binHz } = wf;
			const N = rows.length;
			const B = bins;
			const key = `${cacheToken}`;
			if (!cache || cache.key !== key || cache.w !== N || cache.h !== B) {
				const img = new ImageData(N, B);
				for (let f = 0; f < N; f++) {
					const row = rows[f];
					for (let b = 0; b < B; b++) {
						const db = row[b];
						const v = clamp((db - wf.minDb) / Math.max(1e-6, wf.maxDb - wf.minDb), 0, 1);
						const [r, g, bl] = spectroColor(Math.pow(v, 1.55));
						const idx = ((B - 1 - b) * N + f) * 4;
						img.data[idx] = Math.round(r * 255);
						img.data[idx + 1] = Math.round(g * 255);
						img.data[idx + 2] = Math.round(bl * 255);
						img.data[idx + 3] = 255;
					}
				}
				const off = document.createElement('canvas');
				off.width = N;
				off.height = B;
				off.getContext('2d').putImageData(img, 0, 0);
				cache = { key, w: N, h: B, canvas: off };
			}
			ctx.save();
			ctx.imageSmoothingEnabled = true;
			ctx.drawImage(cache.canvas, 0, plotY, w, plotH);
			ctx.restore();

			// BOAS bands
			const band = (lo, hi, color, label) => {
				const y0 = plotY + plotH - (hi / (binHz * B)) * plotH;
				const y1 = plotY + plotH - (lo / (binHz * B)) * plotH;
				ctx.fillStyle = withAlpha(color, 0.1);
				ctx.fillRect(0, y0, w, Math.max(1, y1 - y0));
				ctx.strokeStyle = withAlpha(color, 0.45);
				ctx.setLineDash([3, 3]);
				ctx.lineWidth = 0.8;
				ctx.beginPath();
				ctx.moveTo(0, y0);
				ctx.lineTo(w, y0);
				ctx.moveTo(0, y1);
				ctx.lineTo(w, y1);
				ctx.stroke();
				ctx.setLineDash([]);
				drawAxisLabel(ctx, label, 5, y0 + 7, { color: withAlpha(color, 0.9), size: 7.5, baseline: 'middle' });
			};
			band(80, 280, amber, 'stertor 80–280');
			band(500, 1800, teal, 'stridor 500–1800');

			// frequency axis
			const maxHz = binHz * B;
			for (const f of FREQUENCY_LANDMARKS.filter((v) => v <= maxHz)) {
				const y = plotY + plotH - (f / maxHz) * plotH;
				drawAxisLabel(ctx, `${f >= 1000 ? f / 1000 + 'k' : f}`, 4, y - 6, { color: withAlpha(textMute, 0.8), size: 7 });
			}

			// playhead
			if (playing) {
				const x = playhead * w;
				ctx.fillStyle = withAlpha(cyan, 0.85);
				ctx.fillRect(x - 0.7, plotY, 1.6, plotH);
			}
		} else {
			drawAxisLabel(ctx, 'awaiting capture', w / 2, plotY + plotH / 2, {
				color: withAlpha(textMute, 0.8),
				size: 10,
				align: 'center'
			});
		}

		// frame chrome
		ctx.strokeStyle = withAlpha(textMute, 0.22);
		ctx.lineWidth = 1;
		ctx.strokeRect(0.5, plotY + 0.5, w - 1, plotH - 1);
	}

	function drawSpectrum() {
		if (!specCanvas) return;
		const setup = setupCanvas(specCanvas, 132);
		if (!setup) return;
		const { ctx, w, h } = setup;
		const pad = { l: 30, r: 8, t: 8, b: 14 };
		const iw = w - pad.l - pad.r;
		const ih = h - pad.t - pad.b;
		const teal = cssVar('--teal', '#10b981');
		const cyan = cssVar('--cyan', '#06b6d4');
		const amber = cssVar('--amber', '#f59e0b');
		const textMute = cssVar('--text-mute', '#6f8299');

		ctx.clearRect(0, 0, w, h);
		if (!features) {
			drawAxisLabel(ctx, 'run a simulator or capture the microphone', w / 2, h / 2, {
				color: textMute,
				size: 9.5,
				align: 'center'
			});
			return;
		}

		const f = features;
		const total = Math.max(1e-9, f.bands.total + f.bands.stertorEnergy * 0.4 + f.bands.stridorEnergy * 0.4);
		const bars = [
			{ key: 'sub', label: '18–80', value: f.bands.sub / total, color: withAlpha(teal, 0.55) },
			{ key: 'low', label: '80–280', value: f.bands.low / total, color: amber },
			{ key: 'mid', label: '280–900', value: f.bands.mid / total, color: teal },
			{ key: 'high', label: '900–2.4k', value: f.bands.high / total, color: cyan },
			{ key: 'top', label: '2.4–6k', value: f.bands.top / total, color: withAlpha(cyan, 0.55) }
		];
		const maxV = Math.max(...bars.map((b) => b.value), 0.01);
		const bw = iw / bars.length;

		bars.forEach((b, i) => {
			const bh = (b.value / maxV) * ih;
			const x = pad.l + i * bw + bw * 0.15;
			const y = pad.t + ih - bh;
			ctx.fillStyle = b.color;
			ctx.fillRect(x, y, bw * 0.7, bh);
			ctx.fillStyle = withAlpha(b.color, 0.18);
			ctx.fillRect(x, pad.t + ih - ih, bw * 0.7, ih - bh);
			drawAxisLabel(ctx, b.label, x + bw * 0.35, h - 5, { color: textMute, size: 7, align: 'center' });
			drawAxisLabel(ctx, `${(b.value * 100).toFixed(0)}%`, x + bw * 0.35, y - 3, {
				color: withAlpha(b.color, 0.95),
				size: 7,
				align: 'center',
				baseline: 'bottom'
			});
		});

		// f0 marker line
		if (f.f0 > 0 && f.f0 < 6000) {
			const norm = Math.log10(Math.max(18, f.f0)) / Math.log10(6000);
			const x = pad.l + clamp(norm, 0, 1) * iw;
			ctx.strokeStyle = withAlpha(cyan, 0.8);
			ctx.setLineDash([2, 3]);
			ctx.beginPath();
			ctx.moveTo(x, pad.t);
			ctx.lineTo(x, pad.t + ih);
			ctx.stroke();
			ctx.setLineDash([]);
			drawAxisLabel(ctx, `f0 ${f.f0.toFixed(1)} Hz`, clamp(x + 4, 4, w - 60), pad.t + 6, {
				color: cyan,
				size: 7.5,
				baseline: 'top'
			});
		}
		drawAxisLabel(ctx, 'band energy share', pad.l, pad.t + 2, { color: withAlpha(textMute, 0.9), size: 7.5, baseline: 'top' });
	}

	/* ------------------------------------------------------------ analysis -- */
	function analyze(buffer, sr, label) {
		analysing = true;
		samples = buffer;
		sampleRate = sr;
		source = label;
		try {
			features = extractFeatures(buffer, sr);
			ranked = classifySignature(features, species);
			boas = computeBOAS(features, { postExercise });
			wf = buildWaterfall(buffer, sr, { fftSize: 2048, hop: 512, maxHz: 6000 });
			cacheToken += 1;
			cache = null;
			bumpVitals({ energy: clamp((features.rmsDb + 60) / 60, 0.05, 1), hr: 96 + Math.round(features.burstRate * 6) });
			drawWaterfall();
			drawSpectrum();
		} catch (err) {
			pushToast(`Analysis failed: ${err.message}`, 'bad');
		} finally {
			analysing = false;
		}
	}

	function runSimulator(key = signatureKey) {
		signatureKey = key;
		stopPlayback();
		const buffer = synthesizeSignature(key, { seconds: DURATION, sampleRate: SAMPLE_RATE });
		analyze(buffer, SAMPLE_RATE, 'simulator');
		if (!muted) play();
	}

	function play() {
		if (!samples) return;
		stopPlayback();
		const started = Date.now();
		const durationMs = (samples.length / sampleRate) * 1000;
		player = playSamples(samples, sampleRate, {
			onEnd: () => {
				playing = false;
				playhead = 0;
				clearInterval(playTimer);
				drawWaterfall();
			}
		});
		if (!player?.available) {
			pushToast('AudioContext blocked — analysis still runs headless', 'warn');
			return;
		}
		playing = true;
		playTimer = setInterval(() => {
			playhead = clamp((Date.now() - started) / durationMs, 0, 1);
			drawWaterfall();
		}, 40);
	}

	function stopPlayback() {
		player?.stop?.();
		player = null;
		playing = false;
		playhead = 0;
		clearInterval(playTimer);
	}

	async function startMic() {
		if (!can('hardware.mic')) {
			pushToast('Microphone requires the Vet Tech tier — use the simulator', 'warn');
			return;
		}
		if (micState === 'recording') return;
		try {
			stream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
			});
			const ctx = getAudioContext();
			if (!ctx) throw new Error('no AudioContext');
			const src = ctx.createMediaStreamSource(stream);
			const analyser = ctx.createAnalyser();
			analyser.fftSize = 4096;
			src.connect(analyser);
			const buf = new Float32Array(analyser.fftSize);
			const chunks = [];
			micState = 'recording';
			capturedSeconds = 0;
			const started = Date.now();
			const sr = ctx.sampleRate;
			captureTimer = setInterval(() => {
				analyser.getFloatTimeDomainData(buf);
				chunks.push(new Float32Array(buf));
				capturedSeconds = (Date.now() - started) / 1000;
				if (capturedSeconds >= 4) {
					clearInterval(captureTimer);
					stream?.getTracks().forEach((t) => t.stop());
					micState = 'idle';
					const total = chunks.reduce((a, c) => a + c.length, 0);
					const merged = new Float32Array(total);
					let o = 0;
					for (const c of chunks) {
						merged.set(c, o);
						o += c.length;
					}
					analyze(merged, sr, 'microphone');
					pushToast('4 s captured — features extracted on-device', 'ok');
				}
			}, 85);
		} catch {
			micState = 'denied';
			pushToast('Microphone blocked — simulator remains fully functional', 'warn');
		}
	}

	async function saveSession() {
		if (!can('vault.write')) {
			pushToast('Read-only tier — switch to Vet Tech to store the session', 'warn');
			return;
		}
		if (!features) return;
		try {
			await saveClinicalRecord('acoustic_sessions', {
				patientId: $patient.name,
				species,
				signature: topMatch?.key ?? 'unclassified',
				confidence: topMatch?.confidence ?? 0,
				f0: features.f0,
				centroid: features.centroid,
				hnr: features.hnr,
				cpp: features.cpp,
				burstRate: features.burstRate,
				boasGrade: boas?.grade ?? null,
				source
			});
			refreshSyncState();
			savedFlash = Date.now();
			pushToast('Acoustic session committed to the vault', 'ok');
		} catch {
			pushToast('Vault write failed', 'bad');
		}
	}

	/* --------------------------------------------------------------- mount -- */
	onMount(() => {
		mounted = true;
		muted = true; // never autoplay before a user gesture
		runSimulator('kennel_cough');
		const ro = new ResizeObserver(() => {
			drawWaterfall();
			drawSpectrum();
		});
		if (wfCanvas) ro.observe(wfCanvas);
		if (specCanvas) ro.observe(specCanvas);
		return () => {
			ro.disconnect();
			stopPlayback();
			stream?.getTracks().forEach((t) => t.stop());
			clearInterval(captureTimer);
		};
	});

	$: if (mounted) {
		void [$theme, species, postExercise];
		if (features) {
			ranked = classifySignature(features, species);
			boas = computeBOAS(features, { postExercise });
		}
		drawWaterfall();
		drawSpectrum();
	}

	$: if ($permissions.mic === 'denied' && micState === 'idle') micState = 'denied';
</script>

<section class="module">
	<div class="module-head">
		<div>
			<h1 class="module-title">Bio-Acoustic <em>Airway Lab</em></h1>
			<p class="module-sub">
				Seven canonical respiratory/vocal signatures synthesised from first principles, then decomposed with
				autocorrelation pitch tracking, cepstral peak prominence, harmonic-to-noise ratio, burst statistics and
				BOAS band energies. Capture 4 s from the microphone or fire a simulator — the analysis path is identical.
			</p>
		</div>
		<div class="row tight">
			<span class="badge {boasTone}"><span class="dot"></span>{boas ? boas.label.split('—')[0].trim() : 'BOAS pending'}</span>
			<span class="badge info"><span class="dot"></span>{source === 'microphone' ? 'microphone' : source === 'simulator' ? 'simulator' : 'idle'}</span>
			{#if playing}<span class="badge ok"><span class="dot"></span>playing</span>{/if}
		</div>
	</div>

	<div class="preset-grid">
		{#each ACOUSTIC_SIGNATURES as s}
			<button class="preset" class:active={signatureKey === s.key} on:click={() => runSimulator(s.key)} title={s.clinical}>
				<span class="p-name">{s.icon} {s.short}</span>
				<span class="p-desc">{s.clinical.slice(0, 46)}…</span>
			</button>
		{/each}
	</div>

	<div class="module-grid">
		<div class="col">
			<div class="card">
				<div class="card-head">
					<span class="card-title">Waterfall spectrogram · 0–6 kHz</span>
					<div class="row tight">
						<button class="btn mini" class:primary={!playing} on:click={() => (playing ? stopPlayback() : play())}>
							{playing ? '■ Stop' : '▶ Play'}
						</button>
						<button class="btn ghost mini" class:active={!muted} on:click={() => (muted = !muted)}>
							{muted ? '🔇' : '🔊'}
						</button>
						<button class="btn ghost mini" class:primary={micState === 'recording'} on:click={startMic}>
							{micState === 'recording' ? `rec ${capturedSeconds.toFixed(1)}s` : '◎ Mic 4 s'}
						</button>
					</div>
				</div>
				<div class="canvas-wrap" style="height:210px">
					<canvas bind:this={wfCanvas} role="img" aria-label="Spectrogram waterfall of the analysed sound"></canvas>
					<div class="canvas-label">STFT 2048 · hop 512</div>
					<div class="canvas-hud">
						<div>{sampleRate / 1000} kHz</div>
						<div>{wf ? `${wf.rows.length} frames` : 'no data'}</div>
					</div>
				</div>
				<div class="band-legend">
					<span><i style="background:var(--amber)"></i>stertor</span>
					<span><i style="background:var(--teal)"></i>stridor</span>
					<span class="grow"></span>
					<span class="mono tiny">{DURATION.toFixed(1)} s window</span>
				</div>
			</div>

			<div class="card">
				<div class="card-head">
					<span class="card-title">Band energy distribution</span>
					<span class="mono tiny dim">{features ? `${fmt(features.rmsDb, 1)} dBFS` : '—'}</span>
				</div>
				<div class="canvas-wrap" style="height:132px">
					<canvas bind:this={specCanvas} role="img" aria-label="Energy share per frequency band"></canvas>
				</div>
			</div>

			<div class="card">
				<div class="card-head">
					<span class="card-title">Feature vector</span>
					<span class="badge info">{species === 'cat' ? 'feline prior' : 'canine prior'}</span>
				</div>
				<div class="metric-grid">
					<div class="metric"><span class="k">Fundamental f0</span><span class="v teal">{features ? fmt(features.f0, 1) : '—'}<small>Hz</small></span></div>
					<div class="metric"><span class="k">Spectral centroid</span><span class="v cyan">{features ? fmt(features.centroid, 0) : '—'}<small>Hz</small></span></div>
					<div class="metric"><span class="k">HNR</span><span class="v">{features ? fmt(features.hnr, 1) : '—'}<small>dB</small></span></div>
					<div class="metric"><span class="k">CPP</span><span class="v violet">{features ? fmt(features.cpp, 2) : '—'}<small>dB</small></span></div>
					<div class="metric"><span class="k">Burst rate</span><span class="v amber">{features ? fmt(features.burstRate, 1) : '—'}<small>/s</small></span></div>
					<div class="metric"><span class="k">Duty factor</span><span class="v">{features ? fmt(features.dutyFactor * 100, 0) : '—'}<small>%</small></span></div>
				</div>
				<div class="row spread" style="margin-top:8px">
					<div class="seg">
						<button class:active={species === 'dog'} on:click={() => (species = 'dog')}>Canine</button>
						<button class:active={species === 'cat'} on:click={() => (species = 'cat')}>Feline</button>
					</div>
					<label class="switch">
						<input type="checkbox" bind:checked={postExercise} />
						<span class="track"></span>
						Post-trot test
					</label>
				</div>
			</div>
		</div>

		<div class="col">
			<div class="card">
				<div class="card-head">
					<span class="card-title">Differential ranking</span>
					{#if analysing}<span class="badge warn"><span class="dot"></span>analysing</span>{/if}
				</div>
				<div class="rank-list">
					{#each ranked as r, i}
						<div class="rank-row" class:top={i === 0}>
							<span class="rank-icon">{r.icon}</span>
							<div class="grow">
								<div class="row spread">
									<span class="rank-label">{r.short}</span>
									<span class="mono tiny dim">{r.confidence.toFixed(1)}%</span>
								</div>
								<div class="bar-meter" class:warn={i === 0 && r.confidence < 55}>
									<i style={`width:${clamp(r.confidence, 0, 100)}%`}></i>
								</div>
							</div>
						</div>
					{/each}
					{#if !ranked.length}
						<p class="tiny mute">Run a simulator to populate the differential.</p>
					{/if}
				</div>
				{#if topMatch}
					<p class="tiny mute" style="margin-top:8px">{topMatch.clinical}</p>
				{/if}
			</div>

			<div class="card">
				<div class="card-head">
					<span class="card-title">BOAS functional grading</span>
					<span class="badge {boasTone}"><span class="dot"></span>{boas ? boas.label : '—'}</span>
				</div>
				{#if boas}
					<div class="boas-grid">
						<div class="metric"><span class="k">Estertor ∫80–280</span><span class="v amber">{boas.stertorDb.toFixed(1)}<small>dB</small></span></div>
						<div class="metric"><span class="k">Estridor ∫500–1800</span><span class="v teal">{boas.stridorDb.toFixed(1)}<small>dB</small></span></div>
						<div class="metric"><span class="k">ASOI index</span><span class="v cyan">{boas.asoi.toFixed(0)}<small>%</small></span></div>
						<div class="metric"><span class="k">Severity</span><span class="v {boasTone === 'bad' ? 'coral' : boasTone === 'warn' ? 'amber' : 'teal'}">{boas.severity.toFixed(0)}<small>/100</small></span></div>
					</div>
					<div class="grade-strip">
						{#each [0, 1, 2, 3] as g}
							<span class="grade-pill g{g}" class:on={boas.grade === g}>Grade {['0', 'I', 'II', 'III'][g]}</span>
						{/each}
					</div>
					<div class="action-list">
						{#each boas.actions as a}
							<div class="action-row"><span>▸</span>{a}</div>
						{/each}
					</div>
					<p class="tiny mute" style="margin-top:6px">
						ASOI = stridor ÷ (stridor + stertor) × 100. {postExercise ? 'Post-exercise weighting ×1.38 applied.' : 'Resting measurement — repeat after a 3-minute trot for the functional grade.'}
					</p>
				{/if}
			</div>

			<div class="card">
				<div class="card-head">
					<span class="card-title">Session</span>
					<span class="mono tiny dim">{new Date().toLocaleTimeString('en-GB')}</span>
				</div>
				<div class="kv"><span class="k">Patient</span><span class="v">{$patient.name} · {$patient.species}</span></div>
				<div class="kv"><span class="k">Source</span><span class="v">{source}</span></div>
				<div class="kv"><span class="k">Capture</span><span class="v">{samples ? `${(samples.length / sampleRate).toFixed(2)} s · ${sampleRate} Hz` : '—'}</span></div>
				<div class="kv"><span class="k">Samples</span><span class="v">{samples ? samples.length.toLocaleString('en-US') : '—'}</span></div>
				<div class="row" style="margin-top:9px">
					<button class="btn primary mini grow" on:click={saveSession} disabled={!features}>Commit to vault</button>
					<button class="btn ghost mini" on:click={() => runSimulator(signatureKey)}>Re-run</button>
				</div>
				{#if savedFlash}<p class="tiny mute" style="margin-top:6px">Saved {new Date(savedFlash).toLocaleTimeString('en-GB')}</p>{/if}
			</div>
		</div>
	</div>
</section>

<style>
	.band-legend {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-top: 6px;
		font-size: 9px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-mute);
	}

	.band-legend i {
		display: inline-block;
		width: 8px;
		height: 3px;
		border-radius: 2px;
		margin-right: 4px;
	}

	.rank-list {
		display: flex;
		flex-direction: column;
		gap: 7px;
	}

	.rank-row {
		display: flex;
		align-items: center;
		gap: 9px;
		padding: 5px 7px;
		border-radius: 9px;
		border: 1px solid transparent;
		transition: background 0.25s ease, border-color 0.25s ease;
	}

	.rank-row.top {
		background: color-mix(in srgb, var(--teal) 9%, transparent);
		border-color: color-mix(in srgb, var(--teal) 32%, transparent);
	}

	.rank-icon {
		width: 22px;
		height: 22px;
		border-radius: 7px;
		display: grid;
		place-items: center;
		font-size: 11px;
		background: color-mix(in srgb, var(--card-bg) 80%, transparent);
		border: 1px solid var(--stroke);
		color: var(--text-dim);
		flex: none;
	}

	.rank-label {
		font-size: 10.5px;
		font-weight: 700;
		color: var(--text);
	}

	.bar-meter {
		margin-top: 4px;
	}

	.boas-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(84px, 1fr));
		gap: 8px;
		margin-bottom: 8px;
	}

	.grade-strip {
		display: flex;
		gap: 5px;
		margin-bottom: 8px;
		flex-wrap: wrap;
	}

	.grade-pill {
		font-size: 9px;
		font-weight: 700;
		letter-spacing: 0.05em;
		padding: 4px 8px;
		border-radius: 7px;
		border: 1px solid var(--stroke);
		color: var(--text-mute);
		background: color-mix(in srgb, var(--bg-0) 35%, transparent);
		transition: all 0.25s ease;
	}

	.grade-pill.on {
		color: #04120e;
		font-weight: 800;
	}

	.grade-pill.on.g0 { background: var(--ok); border-color: var(--ok); }
	.grade-pill.on.g1 { background: var(--cyan); border-color: var(--cyan); }
	.grade-pill.on.g2 { background: var(--warn); border-color: var(--warn); }
	.grade-pill.on.g3 { background: var(--bad); border-color: var(--bad); }

	.action-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.action-row {
		display: flex;
		gap: 7px;
		font-size: 10px;
		line-height: 1.45;
		color: var(--text-dim);
	}

	.action-row span {
		color: var(--teal);
		flex: none;
	}
</style>
