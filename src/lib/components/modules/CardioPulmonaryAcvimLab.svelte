<script>
	import { onDestroy, onMount } from 'svelte';
	import {
		bumpVitals,
		can,
		patient,
		pushToast,
		refreshSyncState,
		theme
	} from '$lib/stores/vetStore.js';
	import { saveClinicalRecord } from '$lib/db/indexedDbVetVault.js';
	import {
		acvimStage,
		accelerometerRmsMg,
		analyzePCG,
		breathsPerMinuteFromCount,
		decompensationFlag,
		evaluateSRR,
		getPcgPreset,
		hrvFromRR,
		LEVINE_GRADES,
		PCG_PRESETS,
		RR_PRESETS,
		SRR_THRESHOLD,
		SRR_CRITICAL,
		synthesizePCG,
		synthesizeRRSeries,
		simulateScg,
		scgRmsMilliG,
		AUSCULTATION_SR,
		THRILL_RMS_THRESHOLD_MG
	} from '$lib/engines/vetCardioPulmonaryEngine.js';
	import { bandpass } from '$lib/engines/dspKernels.js';
	import { playSamples } from '$lib/engines/vetBioAcousticEngine.js';
	import { clamp, cssVar, drawAxisLabel, fmt, setupCanvas, withAlpha } from '$lib/utils/format.js';

	/* ------------------------------------------------------------- state -- */
	let presetKey = 'mmvd';
	let samples = null;
	let analysis = null;
	let playing = false;
	let player = null;
	let scgMode = 'simulated'; // simulated | slider
	let scgSlider = THRILL_RMS_THRESHOLD_MG + 6;
	let scgSamples = null;
	let rrKey = 'healthy';
	let rrSeries = [];
	let hrv = null;
	let decomp = null;
	let filterMode = 'bell';
	let pcgCanvas = null;
	let rrCanvas = null;
	let srrCanvas = null;
	let mounted = false;

	let srrHistory = [];
	let srrResult = null;
	let counting = false;
	let countdown = 30;
	let breathCount = 0;
	let countTimer = null;
	let saving = false;

	const HISTORY_SEED = [
		{ daysAgo: 13, bpm: 18 },
		{ daysAgo: 12, bpm: 17 },
		{ daysAgo: 11, bpm: 19 },
		{ daysAgo: 10, bpm: 18 },
		{ daysAgo: 9, bpm: 20 },
		{ daysAgo: 8, bpm: 19 },
		{ daysAgo: 7, bpm: 21 },
		{ daysAgo: 6, bpm: 22 },
		{ daysAgo: 5, bpm: 24 },
		{ daysAgo: 4, bpm: 26 },
		{ daysAgo: 3, bpm: 28 },
		{ daysAgo: 2, bpm: 31 },
		{ daysAgo: 1, bpm: 33 },
		{ daysAgo: 0, bpm: 34 }
	];

	$: gradeIndex = analysis?.grade?.index ?? 0;
	$: stage = acvimStage({
		gradeIndex,
		srrMedian: srrResult?.median7 ?? 0,
		laEnlarged: gradeIndex >= 4,
		cardiomegaly: gradeIndex >= 3
	});

	/* ------------------------------------------------------------ canvases -- */
	function drawPcg() {
		if (!pcgCanvas || !analysis) return;
		const setup = setupCanvas(pcgCanvas, 172);
		if (!setup) return;
		const { ctx, w, h } = setup;
		const pad = { l: 8, r: 8, t: 22, b: 16 };
		const iw = w - pad.l - pad.r;
		const ih = h - pad.t - pad.b;
		const teal = cssVar('--teal', '#10b981');
		const cyan = cssVar('--cyan', '#06b6d4');
		const coral = cssVar('--coral', '#f43f5e');
		const amber = cssVar('--amber', '#f59e0b');
		const textMute = cssVar('--text-mute', '#6f8299');

		const filtered = analysis.filtered;
		const n = filtered.length;
		const step = Math.max(1, Math.floor(n / (iw * 2)));
		ctx.clearRect(0, 0, w, h);

		// waveform
		ctx.beginPath();
		for (let px = 0; px < iw; px++) {
			let min = 0;
			let max = 0;
			const start = Math.floor((px / iw) * n);
			for (let i = start; i < Math.min(n, start + step); i++) {
				min = Math.min(min, filtered[i]);
				max = Math.max(max, filtered[i]);
			}
			const x = pad.l + px + 0.5;
			ctx.moveTo(x, pad.t + ih / 2 - max * (ih / 2) * 0.9);
			ctx.lineTo(x, pad.t + ih / 2 - min * (ih / 2) * 0.9);
		}
		ctx.strokeStyle = withAlpha(teal, 0.85);
		ctx.lineWidth = 1;
		ctx.stroke();

		// Shannon envelope
		const env = analysis.envelope;
		const envMax = Math.max(...env, 1e-9);
		ctx.beginPath();
		for (let px = 0; px < iw; px++) {
			const idx = Math.floor((px / iw) * env.length);
			const v = env[idx] / envMax;
			const x = pad.l + px;
			const y = pad.t + ih - v * ih;
			px ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
		}
		ctx.strokeStyle = withAlpha(cyan, 0.75);
		ctx.lineWidth = 1.4;
		ctx.shadowColor = cyan;
		ctx.shadowBlur = 6;
		ctx.stroke();
		ctx.shadowBlur = 0;

		// S1 / S2 markers
		const totalSamples = n;
		analysis.peaks.forEach((p, i) => {
			const x = pad.l + (p / totalSamples) * iw;
			const label = analysis.labels[i];
			ctx.strokeStyle = label === 'S1' ? withAlpha(amber, 0.75) : withAlpha(coral, 0.6);
			ctx.setLineDash([2, 4]);
			ctx.beginPath();
			ctx.moveTo(x, pad.t);
			ctx.lineTo(x, pad.t + ih);
			ctx.stroke();
			ctx.setLineDash([]);
			if (i < 8) drawAxisLabel(ctx, label, x, pad.t - 6, { color: label === 'S1' ? amber : coral, size: 7, align: 'center' });
		});

		// systole / diastole bracket on the first cycle
		if (analysis.peaks.length >= 3) {
			const x1 = pad.l + (analysis.peaks[0] / totalSamples) * iw;
			const x2 = pad.l + (analysis.peaks[1] / totalSamples) * iw;
			const x3 = pad.l + (analysis.peaks[2] / totalSamples) * iw;
			ctx.strokeStyle = withAlpha(textMute, 0.5);
			ctx.beginPath();
			ctx.moveTo(x1, pad.t + ih - 5);
			ctx.lineTo(x2, pad.t + ih - 5);
			ctx.moveTo(x2, pad.t + ih - 5);
			ctx.lineTo(x3, pad.t + ih - 5);
			ctx.stroke();
			drawAxisLabel(ctx, `systole ${(analysis.systoleS * 1000).toFixed(0)} ms`, (x1 + x2) / 2, h - 5, {
				color: textMute,
				size: 7,
				align: 'center'
			});
			drawAxisLabel(ctx, `diastole ${(analysis.diastoleS * 1000).toFixed(0)} ms`, (x2 + x3) / 2, h - 5, {
				color: textMute,
				size: 7,
				align: 'center'
			});
		}

		drawAxisLabel(ctx, 'PCG waveform + Shannon energy envelope', pad.l, 6, {
			color: withAlpha(textMute, 0.95),
			size: 7.5,
			baseline: 'top'
		});
		drawAxisLabel(ctx, `${analysis.hrBpm.toFixed(0)} bpm`, w - pad.r, 6, {
			color: cyan,
			size: 9,
			align: 'right',
			baseline: 'top'
		});
	}

	function drawRr() {
		if (!rrCanvas || !rrSeries.length) return;
		const setup = setupCanvas(rrCanvas, 124);
		if (!setup) return;
		const { ctx, w, h } = setup;
		const pad = { l: 30, r: 8, t: 12, b: 14 };
		const iw = w - pad.l - pad.r;
		const ih = h - pad.t - pad.b;
		const violet = cssVar('--violet', '#8b5cf6');
		const coral = cssVar('--coral', '#f43f5e');
		const textMute = cssVar('--text-mute', '#6f8299');

		const rr = rrSeries;
		const min = Math.min(...rr) * 0.96;
		const max = Math.max(...rr) * 1.04;
		const x = (i) => pad.l + (i / (rr.length - 1)) * iw;
		const y = (v) => pad.t + ih - ((v - min) / Math.max(1e-9, max - min)) * ih;

		ctx.clearRect(0, 0, w, h);
		ctx.fillStyle = withAlpha(textMute, 0.05);
		ctx.fillRect(pad.l, pad.t, iw, ih);

		// mean line
		const mean = rr.reduce((a, b) => a + b, 0) / rr.length;
		ctx.strokeStyle = withAlpha(textMute, 0.4);
		ctx.setLineDash([3, 3]);
		ctx.beginPath();
		ctx.moveTo(pad.l, y(mean));
		ctx.lineTo(pad.l + iw, y(mean));
		ctx.stroke();
		ctx.setLineDash([]);

		ctx.beginPath();
		rr.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
		ctx.strokeStyle = violet;
		ctx.lineWidth = 1.6;
		ctx.shadowColor = violet;
		ctx.shadowBlur = 7;
		ctx.stroke();
		ctx.shadowBlur = 0;

		rr.forEach((v, i) => {
			ctx.fillStyle = Math.abs(v - mean) > 60 ? coral : withAlpha(violet, 0.85);
			ctx.beginPath();
			ctx.arc(x(i), y(v), 1.7, 0, Math.PI * 2);
			ctx.fill();
		});

		drawAxisLabel(ctx, `${max.toFixed(0)}`, pad.l - 4, pad.t + 2, { color: textMute, size: 7, align: 'right' });
		drawAxisLabel(ctx, `${min.toFixed(0)}`, pad.l - 4, pad.t + ih, { color: textMute, size: 7, align: 'right' });
		drawAxisLabel(ctx, 'RR interval (ms)', pad.l + 2, pad.t + 2, { color: withAlpha(textMute, 0.9), size: 7.5, baseline: 'top' });
	}

	function drawSrr() {
		if (!srrCanvas || !srrResult) return;
		const setup = setupCanvas(srrCanvas, 138);
		if (!setup) return;
		const { ctx, w, h } = setup;
		const pad = { l: 26, r: 10, t: 14, b: 18 };
		const iw = w - pad.l - pad.r;
		const ih = h - pad.t - pad.b;
		const teal = cssVar('--teal', '#10b981');
		const coral = cssVar('--coral', '#f43f5e');
		const amber = cssVar('--amber', '#f59e0b');
		const textMute = cssVar('--text-mute', '#6f8299');

		const rows = srrResult.readings;
		const yMax = Math.max(50, ...rows.map((r) => r.bpm + 6));
		const x = (i) => pad.l + (i / Math.max(1, rows.length - 1)) * iw;
		const y = (v) => pad.t + ih - (v / yMax) * ih;

		ctx.clearRect(0, 0, w, h);

		// threshold bands
		ctx.fillStyle = withAlpha(coral, 0.1);
		ctx.fillRect(pad.l, pad.t, iw, y(SRR_THRESHOLD) - pad.t);
		ctx.fillStyle = withAlpha(amber, 0.06);
		ctx.fillRect(pad.l, y(SRR_THRESHOLD), iw, y(24) - y(SRR_THRESHOLD));

		const line = (value, color, label, dash = [4, 4]) => {
			ctx.strokeStyle = color;
			ctx.setLineDash(dash);
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(pad.l, y(value));
			ctx.lineTo(pad.l + iw, y(value));
			ctx.stroke();
			ctx.setLineDash([]);
			drawAxisLabel(ctx, label, pad.l + iw - 2, y(value) - 5, { color, size: 7, align: 'right' });
		};
		line(SRR_THRESHOLD, withAlpha(coral, 0.9), 'ACVIM 30', [5, 4]);
		line(SRR_CRITICAL, withAlpha(coral, 0.7), 'critical 40', [2, 5]);
		line(24, withAlpha(teal, 0.7), 'normal < 24', [2, 6]);

		// bars
		const bw = Math.max(3, iw / rows.length - 3);
		rows.forEach((r, i) => {
			const bx = x(i) - bw / 2;
			const by = y(r.bpm);
			ctx.fillStyle = r.bpm >= SRR_CRITICAL ? coral : r.bpm >= SRR_THRESHOLD ? amber : teal;
			ctx.globalAlpha = 0.55;
			ctx.fillRect(bx, by, bw, pad.t + ih - by);
			ctx.globalAlpha = 1;
		});

		// rolling median
		ctx.beginPath();
		rows.forEach((r, i) => {
			const v = Math.min(r.bpm, yMax);
			i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v));
		});
		ctx.strokeStyle = withAlpha(teal, 0.9);
		ctx.lineWidth = 1.6;
		ctx.stroke();

		// median7 marker
		const medY = y(Math.min(srrResult.median7, yMax));
		ctx.strokeStyle = withAlpha(cyan2(), 0.85);
		ctx.setLineDash([3, 3]);
		ctx.beginPath();
		ctx.moveTo(pad.l, medY);
		ctx.lineTo(pad.l + iw, medY);
		ctx.stroke();
		ctx.setLineDash([]);
		drawAxisLabel(ctx, `median7 ${srrResult.median7.toFixed(0)}`, pad.l + 2, medY - 5, {
			color: cssVar('--cyan', '#06b6d4'),
			size: 7.5
		});

		drawAxisLabel(ctx, 'br/min', pad.l - 4, pad.t + 2, { color: textMute, size: 7, align: 'right' });
		drawAxisLabel(ctx, `${rows.length} readings`, pad.l + 2, pad.t + 2, {
			color: withAlpha(textMute, 0.9),
			size: 7.5,
			baseline: 'top'
		});
	}

	function cyan2() {
		return cssVar('--cyan', '#06b6d4');
	}

	/* ------------------------------------------------------------ analysis -- */
	/** Bell (24–420 Hz) vs diaphragm (120–800 Hz) chest-piece response. */
	function chestPiece(buffer) {
		const low = filterMode === 'bell' ? 24 : 120;
		const high = filterMode === 'bell' ? 420 : 800;
		return bandpass(buffer, AUSCULTATION_SR, low, high, 2);
	}

	function currentScgRms() {
		if (scgMode === 'simulated') {
			if (!scgSamples) scgSamples = simulateScg({ presetKey, seconds: 3, sampleRate: 200 });
			return scgRmsMilliG(scgSamples);
		}
		return Number(scgSlider) || 0;
	}

	function computeAnalysis() {
		if (!samples) return null;
		return analyzePCG(chestPiece(samples), {
			sampleRate: AUSCULTATION_SR,
			scgRmsMg: currentScgRms(),
			presetKey
		});
	}

	function runPcg(key = presetKey) {
		presetKey = key;
		stopPlay();
		samples = synthesizePCG(key, { seconds: 4.0, sampleRate: AUSCULTATION_SR });
		if (scgMode === 'simulated') scgSamples = simulateScg({ presetKey: key, seconds: 3, sampleRate: 200 });
		analysis = computeAnalysis();
		if (analysis) bumpVitals({ hr: analysis.hrBpm, energy: clamp(analysis.smer / 30, 0.05, 1) });
		drawPcg();
	}

	function runRr(key = rrKey) {
		rrKey = key;
		const res = synthesizeRRSeries(key, { beats: 44 });
		rrSeries = res.rr;
		hrv = hrvFromRR(rrSeries);
		decomp = decompensationFlag({ cvrr: hrv.cvrr, meanHr: hrv.meanHr });
		drawRr();
	}

	function play() {
		if (!samples) return;
		stopPlay();
		player = playSamples(samples, AUSCULTATION_SR, { onEnd: () => (playing = false) });
		playing = !!player?.available;
		if (!playing) pushToast('AudioContext blocked — analysis still runs headless', 'warn');
	}

	function stopPlay() {
		player?.stop?.();
		player = null;
		playing = false;
	}

	/* --------------------------------------------------------------- SRR ---- */
	function addReading(bpm, label = 'manual') {
		const value = Number(bpm);
		if (!isFinite(value) || value <= 0) return;
		srrHistory = [
			...srrHistory,
			{ date: new Date().toISOString(), bpm: value, source: label, patient: $patient.name }
		];
		srrResult = evaluateSRR(srrHistory);
		bumpVitals({ hr: 100 + value });
		drawSrr();
		if (srrResult.status === 'alert' || srrResult.status === 'critical') {
			pushToast(`ACVIM alert — rolling median ${srrResult.median7.toFixed(0)} br/min`, 'bad', 6000);
			if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate([60, 80, 60, 80, 140]);
		}
	}

	function startCount() {
		if (counting) return;
		counting = true;
		breathCount = 0;
		countdown = 30;
		countTimer = setInterval(() => {
			countdown -= 1;
			if (countdown <= 0) {
				clearInterval(countTimer);
				counting = false;
				const bpm = breathsPerMinuteFromCount(breathCount, 30);
				if (bpm > 0) addReading(bpm, '30 s count');
				else pushToast('No breaths tapped — count discarded', 'warn');
				breathCount = 0;
			}
		}, 1000);
	}

	function simulateChf() {
		srrHistory = [
			...srrHistory,
			{ date: new Date(Date.now() - 2000).toISOString(), bpm: 37, source: 'simulated', patient: $patient.name },
			{ date: new Date(Date.now() - 1000).toISOString(), bpm: 39, source: 'simulated', patient: $patient.name },
			{ date: new Date().toISOString(), bpm: 42, source: 'simulated', patient: $patient.name }
		];
		srrResult = evaluateSRR(srrHistory);
		drawSrr();
		pushToast('CHF decompensation pattern injected — SRR ≥ 40', 'bad', 6000);
	}

	function resetSrr() {
		srrHistory = [];
		srrResult = evaluateSRR(srrHistory);
		drawSrr();
	}

	/* ------------------------------------------------------------- saving --- */
	async function saveCardio() {
		if (!can('vault.write')) {
			pushToast('Read-only tier — switch to Vet Tech to store the log', 'warn');
			return;
		}
		saving = true;
		try {
			await saveClinicalRecord('cardio_logs', {
				patientId: $patient.name,
				species: $patient.species,
				preset: presetKey,
				smer: Number((analysis?.smer ?? 0).toFixed(2)),
				levine: analysis?.grade.roman ?? null,
				heartRate: Number((analysis?.hrBpm ?? 0).toFixed(0)),
				scgRmsMg: Number((analysis?.scgRmsMg ?? 0).toFixed(1)),
				hrvCvrr: Number((hrv?.cvrr ?? 0).toFixed(2)),
				srrMedian: Number((srrResult?.median7 ?? 0).toFixed(1)),
				srrStatus: srrResult?.status ?? 'no-data',
				acvimStage: stage.stage
			});
			refreshSyncState();
			pushToast('Cardio-pulmonary log committed to the vault', 'ok');
		} catch {
			pushToast('Vault write failed', 'bad');
		} finally {
			saving = false;
		}
	}

	/* --------------------------------------------------------------- mount -- */
	onMount(() => {
		mounted = true;
		srrHistory = HISTORY_SEED.map((h) => ({
			date: new Date(Date.now() - h.daysAgo * 86400000).toISOString(),
			bpm: h.bpm,
			source: 'seed',
			patient: $patient.name
		}));
		srrResult = evaluateSRR(srrHistory);
		runRr('healthy');
		runPcg('mmvd');
		drawSrr();
		const ro = new ResizeObserver(() => {
			drawPcg();
			drawRr();
			drawSrr();
		});
		[pcgCanvas, rrCanvas, srrCanvas].forEach((c) => c && ro.observe(c));
		return () => {
			ro.disconnect();
			stopPlay();
			clearInterval(countTimer);
		};
	});

	onDestroy(() => {
		stopPlay();
		clearInterval(countTimer);
	});

	$: if (mounted && samples) {
		void [$theme, presetKey, scgMode, scgSlider, filterMode];
		analysis = computeAnalysis();
		drawPcg();
		drawRr();
		drawSrr();
	}

	$: scgRmsDisplay = analysis?.scgRmsMg ?? scgSlider;
</script>

<section class="module">
	<div class="module-head">
		<div>
			<h1 class="module-title">Cardio-Pulmonary <em>ACVIM Lab</em></h1>
			<p class="module-sub">
				Phonocardiogram segmentation with Shannon-energy S1/S2 detection, SMER → Levine I–VI grading lifted by
				seismocardiogram thrill RMS, RSA/HRV decompensation screening, and the ACVIM sleeping respiratory rate
				consensus monitor with a rolling 7-reading median against a 14-day baseline.
			</p>
		</div>
		<div class="row tight">
			<span class="badge {stage.tone}"><span class="dot"></span>{stage.label}</span>
			<span class="badge info"><span class="dot"></span>Levine {analysis?.grade.roman ?? '—'}</span>
			{#if srrResult?.status !== 'no-data'}<span class="badge {srrResult.tone}"><span class="dot"></span>SRR {srrResult.median7.toFixed(0)}</span>{/if}
		</div>
	</div>

	<div class="preset-grid">
		{#each PCG_PRESETS as p}
			<button class="preset" class:active={presetKey === p.key} on:click={() => runPcg(p.key)} title={p.pathology ?? p.note}>
				<span class="p-name">{p.short}</span>
				<span class="p-desc">{p.hrBpm} bpm · expected {p.expectedGrade}/VI</span>
			</button>
		{/each}
	</div>

	<div class="module-grid wide-left">
		<div class="col">
			<div class="card">
				<div class="card-head">
					<span class="card-title">Phonocardiogram · {getPcgPreset(presetKey).short}</span>
					<div class="row tight">
						<button class="btn mini" class:primary={!playing} on:click={() => (playing ? stopPlay() : play())}>
							{playing ? '■ Stop' : '▶ Play'}
						</button>
						<div class="seg">
							<button class:active={filterMode === 'bell'} on:click={() => (filterMode = 'bell')} title="Bell 24–420 Hz">Bell</button>
							<button class:active={filterMode === 'diaphragm'} on:click={() => (filterMode = 'diaphragm')} title="Diaphragm 120–800 Hz">Diaph</button>
						</div>
					</div>
				</div>
				<div class="canvas-wrap" style="height:172px">
					<canvas bind:this={pcgCanvas} role="img" aria-label="Phonocardiogram waveform with S1 and S2 markers"></canvas>
				</div>
				<div class="pcg-stats">
					<div class="metric"><span class="k">HR</span><span class="v cyan">{analysis ? fmt(analysis.hrBpm, 0) : '—'}<small>bpm</small></span></div>
					<div class="metric"><span class="k">SMER</span><span class="v coral">{analysis ? fmt(analysis.smer, 1) : '—'}<small>%</small></span></div>
					<div class="metric"><span class="k">S1/S2 peaks</span><span class="v">{analysis?.peaks.length ?? 0}</span></div>
					<div class="metric"><span class="k">Cycle</span><span class="v">{analysis ? fmt(analysis.cycleS * 1000, 0) : '—'}<small>ms</small></span></div>
					<div class="metric"><span class="k">SCG RMS</span><span class="v amber">{fmt(scgRmsDisplay, 1)}<small>mG</small></span></div>
					<div class="metric"><span class="k">Thrill</span><span class="v {analysis?.thrill ? 'coral' : 'teal'}">{analysis?.thrill ? 'yes' : 'no'}</span></div>
				</div>
			</div>

			<div class="card">
				<div class="card-head">
					<span class="card-title">Levine grading</span>
					<span class="badge {gradeIndex >= 4 ? 'bad' : gradeIndex >= 2 ? 'warn' : 'ok'}">
						<span class="dot"></span>{analysis?.grade.label ?? '—'}
					</span>
				</div>
				<div class="levine-strip">
					{#each LEVINE_GRADES as g, i}
						<div class="levine-cell g{i + 1}" class:on={analysis && analysis.grade.roman === g.roman}>
							<span class="levine-roman">{g.roman}</span>
							<span class="levine-smer">{g.smerMin}{g.smerMax === Infinity ? '+' : `–${g.smerMax}`}</span>
						</div>
					{/each}
				</div>
				<p class="small" style="margin:6px 0 0;color:var(--text-dim)">{analysis?.grade.desc ?? ''}</p>
				<div class="kv" style="margin-top:6px"><span class="k">Interpretation</span><span class="v">{analysis?.note ?? '—'}</span></div>

				<div class="divider"></div>

				<div class="row spread">
					<span class="label">Thrill source</span>
					<div class="seg">
						<button class:active={scgMode === 'simulated'} on:click={() => (scgMode = 'simulated')}>Simulated SCG</button>
						<button class:active={scgMode === 'slider'} on:click={() => (scgMode = 'slider')}>Manual mG</button>
					</div>
				</div>
				{#if scgMode === 'slider'}
					<div class="row tight" style="margin-top:6px">
						<input type="range" min="0" max="90" step="1" bind:value={scgSlider} aria-label="Seismocardiogram RMS in milli-g" />
						<span class="mono tiny nowrap">{scgSlider} mG</span>
					</div>
					<p class="tiny mute" style="margin:4px 0 0">
						Threshold {THRILL_RMS_THRESHOLD_MG} mG — above this the murmur is upgraded to grade VI (palpable thrill).
					</p>
				{:else}
					<p class="tiny mute" style="margin:6px 0 0">
						SCG trace synthesised at 200 Hz for this preset; RMS {fmt(scgRmsDisplay, 1)} mG measured from the
						accelerometer buffer.
					</p>
				{/if}
			</div>

			<div class="card">
				<div class="card-head">
					<span class="card-title">RSA / heart-rate variability</span>
					<span class="badge {decomp?.level ?? 'ok'}"><span class="dot"></span>{hrv ? `CV_RR ${hrv.cvrr.toFixed(1)} %` : '—'}</span>
				</div>
				<div class="row tight" style="margin-bottom:8px">
					{#each RR_PRESETS as p}
						<button class="chip" class:active={rrKey === p.key} on:click={() => runRr(p.key)} title={p.note}>{p.label}</button>
					{/each}
				</div>
				<div class="canvas-wrap" style="height:124px">
					<canvas bind:this={rrCanvas} role="img" aria-label="RR interval tachogram"></canvas>
				</div>
				<div class="metric-grid" style="margin-top:8px">
					<div class="metric"><span class="k">Mean HR</span><span class="v violet">{hrv ? fmt(hrv.meanHr, 0) : '—'}<small>bpm</small></span></div>
					<div class="metric"><span class="k">RMSSD</span><span class="v">{hrv ? fmt(hrv.rmssd, 1) : '—'}<small>ms</small></span></div>
					<div class="metric"><span class="k">SDNN</span><span class="v">{hrv ? fmt(hrv.sdnn, 1) : '—'}<small>ms</small></span></div>
					<div class="metric"><span class="k">pNN50</span><span class="v cyan">{hrv ? fmt(hrv.pnn50, 0) : '—'}<small>%</small></span></div>
				</div>
				<div class="verdict {decomp?.level ?? 'ok'}" style="margin-top:9px">
					<div class="med-icon {decomp?.level === 'critical' ? 'bad' : decomp?.level === 'warn' ? 'warn' : ''}">{decomp?.active ? '!' : '✓'}</div>
					<div>
						<div class="verdict-title">{decomp?.title ?? '—'}</div>
						<div class="verdict-body">{decomp?.body ?? ''}</div>
					</div>
				</div>
			</div>
		</div>

		<div class="col">
			<div class="card">
				<div class="card-head">
					<span class="card-title">ACVIM sleeping respiratory rate</span>
					<span class="badge {srrResult?.tone ?? 'ok'}"><span class="dot"></span>{srrResult?.status?.toUpperCase() ?? '—'}</span>
				</div>

				<div class="srr-hero">
					<div class="metric">
						<span class="k">Rolling median (7)</span>
						<span class="v {srrResult?.tone === 'bad' ? 'coral' : srrResult?.tone === 'warn' ? 'amber' : 'teal'}">
							{srrResult ? srrResult.median7.toFixed(0) : '—'}<small>br/min</small>
						</span>
					</div>
					<div class="srr-threshold">
						<span class="mono tiny mute">threshold</span>
						<span class="mono srr-30">{SRR_THRESHOLD}</span>
					</div>
				</div>

				<div class="canvas-wrap" style="height:138px">
					<canvas bind:this={srrCanvas} role="img" aria-label="Sleeping respiratory rate trend against the ACVIM threshold"></canvas>
				</div>

				<div class="verdict {srrResult?.tone === 'bad' ? 'bad' : srrResult?.tone === 'warn' ? 'warn' : 'info'}" style="margin-top:9px">
					<div class="med-icon {srrResult?.tone === 'bad' ? 'bad' : 'warn'}">{srrResult?.status === 'normal' ? '✓' : '!'}</div>
					<div>
						<div class="verdict-title">{srrResult?.title ?? 'No readings'}</div>
						<div class="verdict-body">{srrResult?.body ?? ''}</div>
					</div>
				</div>

				<div class="divider"></div>

				<div class="counter-box">
					<div class="row spread">
						<span class="label">30-second breath counter</span>
						<span class="mono tiny {counting ? 'coral' : 'mute'}">{counting ? `${countdown}s` : 'ready'}</span>
					</div>
					<div class="counter-main">
						<button class="breath-btn" class:pulse={counting} on:click={() => counting && (breathCount += 1)} disabled={!counting}>
							<span class="breath-num">{breathCount}</span>
							<span class="breath-hint">{counting ? 'tap each breath' : 'start the timer'}</span>
						</button>
						<div class="counter-side">
							{#if counting}
								<div class="mono tiny mute">counting…</div>
								<div class="mono srr-live">{(breathCount * 2).toFixed(0)} br/min</div>
							{:else}
								<button class="btn primary mini" on:click={startCount}>Start 30 s</button>
								<div class="row tight" style="margin-top:6px">
									{#each [22, 26, 30, 34, 40] as q}
										<button class="chip" on:click={() => addReading(q, 'quick')}>{q}</button>
									{/each}
								</div>
							{/if}
						</div>
					</div>
				</div>

				<div class="row tight" style="margin-top:9px">
					<button class="btn ghost mini" on:click={simulateChf}>Simulate CHF</button>
					<button class="btn ghost mini" on:click={resetSrr}>Clear</button>
					<span class="grow"></span>
					<span class="mono tiny mute">{srrResult?.readings.length ?? 0} readings</span>
				</div>
			</div>

			<div class="card">
				<div class="card-head">
					<span class="card-title">ACVIM staging</span>
					<span class="badge {stage.tone}"><span class="dot"></span>{stage.stage}</span>
				</div>
				<div class="stage-row">
					{#each ['A', 'B1', 'B2', 'C'] as s}
						<span class="stage-pill" class:on={stage.stage === s}>{s}</span>
					{/each}
				</div>
				<p class="small" style="margin:8px 0 0;color:var(--text-dim)">{stage.note}</p>
				<div class="kv" style="margin-top:8px"><span class="k">Baseline (14 d)</span><span class="v">{srrResult ? srrResult.baseline.toFixed(1) : '—'} br/min</span></div>
				<div class="kv"><span class="k">Delta vs baseline</span><span class="v">{srrResult ? `${srrResult.deltaPct > 0 ? '+' : ''}${srrResult.deltaPct.toFixed(0)} %` : '—'}</span></div>
				<div class="kv"><span class="k">Latest reading</span><span class="v">{srrResult ? srrResult.latest.toFixed(0) : '—'} br/min</span></div>
				<div class="row" style="margin-top:10px">
					<button class="btn primary mini grow" on:click={saveCardio} disabled={saving}>
						{saving ? 'Writing…' : 'Commit cardio log'}
					</button>
				</div>
				<p class="tiny mute" style="margin-top:7px">
					Count only while the patient is genuinely asleep — excitement, pain, heat and dreaming all raise SRR
					without pulmonary oedema. Three readings establish a baseline; the 7-reading median suppresses noise.
				</p>
			</div>
		</div>
	</div>
</section>

<style>
	.pcg-stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(74px, 1fr));
		gap: 8px;
		margin-top: 8px;
	}

	.levine-strip {
		display: grid;
		grid-template-columns: repeat(6, 1fr);
		gap: 4px;
	}

	.levine-cell {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		padding: 6px 2px;
		border-radius: 8px;
		border: 1px solid var(--stroke);
		background: color-mix(in srgb, var(--bg-0) 30%, transparent);
		opacity: 0.5;
		transition: all 0.28s var(--ease-spring);
	}

	.levine-cell.on {
		opacity: 1;
		transform: translateY(-2px);
		border-color: color-mix(in srgb, var(--teal) 55%, transparent);
		background: color-mix(in srgb, var(--teal) 14%, transparent);
		box-shadow: 0 0 18px -8px var(--teal);
	}

	.levine-cell.on.g4,
	.levine-cell.on.g5,
	.levine-cell.on.g6 {
		border-color: color-mix(in srgb, var(--coral) 55%, transparent);
		background: color-mix(in srgb, var(--coral) 14%, transparent);
		box-shadow: 0 0 18px -8px var(--coral);
	}

	.levine-roman {
		font-family: var(--font-mono);
		font-size: 13px;
		font-weight: 800;
		color: var(--text);
	}

	.levine-smer {
		font-family: var(--font-mono);
		font-size: 6.5px;
		color: var(--text-mute);
		letter-spacing: 0.02em;
	}

	.srr-hero {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		margin-bottom: 8px;
	}

	.srr-hero .metric .v {
		font-size: 30px;
	}

	.srr-threshold {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
	}

	.srr-30 {
		font-size: 18px;
		font-weight: 800;
		color: var(--coral);
		line-height: 1;
	}

	.counter-box {
		padding: 9px 10px;
		border-radius: 12px;
		border: 1px solid var(--stroke);
		background: color-mix(in srgb, var(--bg-0) 30%, transparent);
	}

	.counter-main {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-top: 8px;
	}

	.breath-btn {
		appearance: none;
		width: 84px;
		height: 84px;
		border-radius: 50%;
		border: 1.5px solid color-mix(in srgb, var(--teal) 50%, transparent);
		background: radial-gradient(circle at 34% 28%, color-mix(in srgb, var(--teal) 30%, transparent), transparent 70%);
		color: var(--text);
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1px;
		cursor: pointer;
		flex: none;
		transition: transform 0.18s var(--ease-spring), box-shadow 0.25s ease, border-color 0.25s ease;
	}

	.breath-btn:active {
		transform: scale(0.94);
	}

	.breath-btn:disabled {
		cursor: default;
		opacity: 0.75;
	}

	.breath-btn.pulse {
		box-shadow: 0 0 0 0 color-mix(in srgb, var(--teal) 45%, transparent);
		animation: breathe 1.6s ease-out infinite;
	}

	@keyframes breathe {
		0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--teal) 40%, transparent); }
		70% { box-shadow: 0 0 0 14px transparent; }
		100% { box-shadow: 0 0 0 0 transparent; }
	}

	.breath-num {
		font-family: var(--font-mono);
		font-size: 26px;
		font-weight: 800;
		line-height: 1;
		color: var(--teal);
	}

	.breath-hint {
		font-size: 7px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-mute);
	}

	.counter-side {
		flex: 1 1 auto;
		min-width: 0;
	}

	.srr-live {
		font-size: 15px;
		font-weight: 700;
		color: var(--cyan);
	}

	.stage-row {
		display: flex;
		gap: 6px;
	}

	.stage-pill {
		flex: 1;
		text-align: center;
		padding: 7px 4px;
		border-radius: 9px;
		border: 1px solid var(--stroke);
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 700;
		color: var(--text-mute);
		transition: all 0.28s ease;
	}

	.stage-pill.on {
		background: color-mix(in srgb, var(--teal) 18%, transparent);
		border-color: color-mix(in srgb, var(--teal) 55%, transparent);
		color: var(--text);
		box-shadow: 0 0 18px -8px var(--teal);
	}
</style>
