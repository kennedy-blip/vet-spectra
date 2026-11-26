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
	import { createMacroLens } from '$lib/gl/vetGl.js';
	import {
		attachmentHoursFromSI,
		auditQuote,
		buildRiskTimeline,
		buildTickRecord,
		classifyGingiva,
		GINGIVA_CLASSES,
		getTickSpecies,
		labToCss,
		parseLineItems,
		PROCEDURES,
		REGIONS,
		scutalIndex,
		SPECIMEN_PRESETS,
		TICK_SPECIES,
		transmissionRisk
	} from '$lib/engines/tickScutalDermaAuditorEngine.js';
	import { clamp, cssVar, drawAxisLabel, fmt, setupCanvas, withAlpha } from '$lib/utils/format.js';

	/* ------------------------------------------------------------- state -- */
	let speciesKey = 'ixodes_scapularis';
	let specimenKey = 'partial';
	let lengthMm = 8.2;
	let widthMm = 3.6;
	let zoom = 2.0;
	let edge = 0.5;
	let falseColor = false;
	let lensMode = 'tick';
	let lensCanvas = null;
	let lens = null;
	let videoEl = null;
	let stream = null;
	let cameraOn = false;
	let cameraTimer = null;
	let mounted = false;
	let timelineCanvas = null;

	let labL = 62;
	let labA = 30;
	let labB = 16;
	let crtSeconds = 1.2;
	let crtRunning = false;
	let crtStart = 0;
	let crtTimer = null;

	let procedureKey = 'dental';
	let quotedTotal = 1180;
	let regionKey = 'us_coastal';
	let emergency = false;
	let lineItemText = 'Dental scaling and polish: 640\nGeneral anaesthesia: 280\nFull-mouth radiographs: 180\nAnaesthetic monitoring: 90';
	let coveragePct = 80;
	let deductible = 250;
	let allowedFactor = 0.85;
	let annualUsed = 0;
	let saving = false;
	let savedId = null;

	$: specimen = SPECIMEN_PRESETS.find((s) => s.key === specimenKey) || SPECIMEN_PRESETS[0];
	$: si = scutalIndex(lengthMm, widthMm);
	$: attach = attachmentHoursFromSI(si, speciesKey);
	$: risk = transmissionRisk({ hours: attach.hours, speciesKey, si });
	$: tSpecies = getTickSpecies(speciesKey);
	$: timeline = buildRiskTimeline(speciesKey, 96);
	$: gingiva = classifyGingiva({ L: labL, a: labA, b: labB, crtSeconds });
	$: lineItems = parseLineItems(lineItemText);
	$: quote = auditQuote({
		procedureKey,
		quotedTotal,
		regionKey,
		lineItems,
		emergency,
		insurance: { coveragePct, deductible, annualUsed, allowedFactor }
	});
	$: riskTone = risk.tone;

	/* ----------------------------------------------------- specimen texture -- */
	function buildSpecimenCanvas() {
		const c = document.createElement('canvas');
		c.width = 560;
		c.height = 560;
		const g = c.getContext('2d');
		const W = c.width;
		const H = c.height;

		// skin / dermis background
		const skin = g.createRadialGradient(W * 0.42, H * 0.38, W * 0.06, W * 0.5, H * 0.5, W * 0.78);
		skin.addColorStop(0, lensMode === 'tick' ? '#3a2a22' : '#a8434a');
		skin.addColorStop(0.55, lensMode === 'tick' ? '#241a15' : '#7d2c36');
		skin.addColorStop(1, '#120c0a');
		g.fillStyle = skin;
		g.fillRect(0, 0, W, H);

		// dermal texture
		let seed = 987654321;
		const rnd = () => {
			seed = (seed * 1664525 + 1013904223) % 4294967296;
			return seed / 4294967296;
		};
		for (let i = 0; i < 1400; i++) {
			const x = rnd() * W;
			const y = rnd() * H;
			const r = 0.4 + rnd() * 1.7;
			g.globalAlpha = 0.06 + rnd() * 0.12;
			g.fillStyle = rnd() > 0.5 ? '#e8c6a8' : '#180f0b';
			g.beginPath();
			g.arc(x, y, r, 0, Math.PI * 2);
			g.fill();
		}
		g.globalAlpha = 1;

		// hairs
		for (let i = 0; i < 26; i++) {
			const x = rnd() * W;
			const y = rnd() * H;
			g.strokeStyle = `rgba(20,14,10,${0.25 + rnd() * 0.35})`;
			g.lineWidth = 1 + rnd() * 1.2;
			g.beginPath();
			g.moveTo(x, y);
			g.quadraticCurveTo(x + 30, y - 18, x + 64, y - 42);
			g.stroke();
		}

		if (lensMode === 'gingiva') {
			// gingival margin with two teeth
			g.fillStyle = 'rgba(255,250,244,0.94)';
			for (const tx of [0.24, 0.56]) {
				const x0 = W * tx;
				const y0 = H * 0.06;
				const ww = W * 0.2;
				const hh = H * 0.42;
				const rr = 24;
				g.beginPath();
				g.moveTo(x0 + rr, y0);
				g.arcTo(x0 + ww, y0, x0 + ww, y0 + hh, rr);
				g.arcTo(x0 + ww, y0 + hh, x0, y0 + hh, rr);
				g.arcTo(x0, y0 + hh, x0, y0, rr);
				g.arcTo(x0, y0, x0 + ww, y0, rr);
				g.closePath();
				g.fill();
			}
			const gum = g.createLinearGradient(0, H * 0.3, 0, H);
			gum.addColorStop(0, '#c8545e');
			gum.addColorStop(0.6, '#a0313c');
			gum.addColorStop(1, '#6d1f28');
			g.fillStyle = gum;
			g.fillRect(0, H * 0.4, W, H * 0.6);
			for (let i = 0; i < 900; i++) {
				g.globalAlpha = 0.05 + rnd() * 0.1;
				g.fillStyle = rnd() > 0.5 ? '#ffd9c9' : '#4d1018';
				g.beginPath();
				g.arc(rnd() * W, H * 0.42 + rnd() * H * 0.55, 0.5 + rnd() * 2, 0, Math.PI * 2);
				g.fill();
			}
			g.globalAlpha = 1;
			// specular wet line
			g.strokeStyle = 'rgba(255,230,225,0.35)';
			g.lineWidth = 5;
			g.beginPath();
			g.moveTo(W * 0.05, H * 0.47);
			g.bezierCurveTo(W * 0.35, H * 0.41, W * 0.65, H * 0.5, W * 0.95, H * 0.44);
			g.stroke();
			return c;
		}

		/* ---- tick specimen ---- */
		const ratio = clamp(lengthMm / Math.max(0.5, widthMm), 1, 4.2);
		const bodyLen = clamp(W * 0.34 * (0.72 + ratio * 0.14), W * 0.2, W * 0.62);
		const bodyWid = bodyLen / ratio;
		const cx = W / 2;
		const cy = H * 0.56;
		const baseColor = specimen.colour;

		// legs (4 pairs)
		g.strokeStyle = 'rgba(28,18,12,0.9)';
		for (const side of [-1, 1]) {
			for (let i = 0; i < 4; i++) {
				const off = (i - 1.5) * bodyLen * 0.18;
				const startX = cx + side * bodyWid * 0.42;
				const startY = cy + off;
				const kneeX = startX + side * bodyWid * (0.55 + i * 0.08);
				const kneeY = startY - bodyLen * 0.1 + i * bodyLen * 0.05;
				const footX = kneeX + side * bodyWid * 0.5;
				const footY = kneeY + bodyLen * (0.16 + i * 0.02);
				g.lineWidth = Math.max(2.4, bodyWid * 0.055);
				g.beginPath();
				g.moveTo(startX, startY);
				g.quadraticCurveTo(kneeX, kneeY - bodyLen * 0.12, footX, footY);
				g.stroke();
			}
		}

		// body
		const bodyGrad = g.createRadialGradient(
			cx - bodyWid * 0.25,
			cy - bodyLen * 0.18,
			bodyWid * 0.12,
			cx,
			cy,
			bodyLen * 0.72
		);
		bodyGrad.addColorStop(0, shade(baseColor, 42));
		bodyGrad.addColorStop(0.62, baseColor);
		bodyGrad.addColorStop(1, shade(baseColor, -46));
		g.fillStyle = bodyGrad;
		g.beginPath();
		g.ellipse(cx, cy, bodyWid * 0.72, bodyLen * 0.5, 0, 0, Math.PI * 2);
		g.fill();

		// scutum shield at the anterior pole
		const scutW = bodyWid * 0.66;
		const scutH = bodyLen * (lensMode === 'tick' ? 0.3 : 0.34);
		g.save();
		g.translate(cx, cy - bodyLen * 0.33);
		const scutGrad = g.createLinearGradient(0, -scutH, 0, scutH * 0.4);
		scutGrad.addColorStop(0, '#241610');
		scutGrad.addColorStop(1, '#4a2f1f');
		g.fillStyle = scutGrad;
		g.strokeStyle = 'rgba(255,214,170,0.28)';
		g.lineWidth = 1.4;
		g.beginPath();
		g.moveTo(0, -scutH);
		g.bezierCurveTo(scutW, -scutH * 0.4, scutW * 0.92, scutH * 0.55, 0, scutH * 0.7);
		g.bezierCurveTo(-scutW * 0.92, scutH * 0.55, -scutW, -scutH * 0.4, 0, -scutH);
		g.closePath();
		g.fill();
		g.stroke();
		g.restore();

		// scutum width measurement brackets (burned into the texture at 1:1)
		g.strokeStyle = 'rgba(6,182,212,0.85)';
		g.lineWidth = 1.6;
		g.beginPath();
		g.moveTo(cx - scutW, cy - bodyLen * 0.33);
		g.lineTo(cx + scutW, cy - bodyLen * 0.33);
		g.stroke();
		for (const sx of [-1, 1]) {
			g.beginPath();
			g.moveTo(cx + sx * scutW, cy - bodyLen * 0.33 - 10);
			g.lineTo(cx + sx * scutW, cy - bodyLen * 0.33 + 10);
			g.stroke();
		}

		// capitulum / mouthparts
		g.fillStyle = '#2a1a12';
		g.beginPath();
		g.ellipse(cx, cy - bodyLen * 0.5 - 10, bodyWid * 0.26, bodyLen * 0.09, 0, 0, Math.PI * 2);
		g.fill();
		g.strokeStyle = 'rgba(240,220,200,0.35)';
		g.lineWidth = 2;
		g.beginPath();
		g.moveTo(cx, cy - bodyLen * 0.5 - 16);
		g.lineTo(cx, cy - bodyLen * 0.5 - 34);
		g.stroke();

		// specular highlight
		const spec = g.createRadialGradient(cx - bodyWid * 0.3, cy + bodyLen * 0.14, 2, cx - bodyWid * 0.3, cy + bodyLen * 0.14, bodyLen * 0.5);
		spec.addColorStop(0, 'rgba(255,245,230,0.4)');
		spec.addColorStop(1, 'rgba(255,245,230,0)');
		g.fillStyle = spec;
		g.beginPath();
		g.ellipse(cx, cy, bodyWid * 0.72, bodyLen * 0.5, 0, 0, Math.PI * 2);
		g.fill();

		return c;
	}

	function shade(hex, amount) {
		const n = parseInt(hex.replace('#', ''), 16);
		const r = clamp(((n >> 16) & 255) + amount, 0, 255);
		const gg = clamp(((n >> 8) & 255) + amount, 0, 255);
		const b = clamp((n & 255) + amount, 0, 255);
		return `rgb(${r},${gg},${b})`;
	}

	function refreshTexture() {
		if (!lens) return;
		lens.upload(buildSpecimenCanvas());
	}

	/* ---------------------------------------------------------- timeline ---- */
	function drawTimeline() {
		if (!timelineCanvas) return;
		const setup = setupCanvas(timelineCanvas, 150);
		if (!setup) return;
		const { ctx, w, h } = setup;
		const pad = { l: 28, r: 10, t: 12, b: 18 };
		const iw = w - pad.l - pad.r;
		const ih = h - pad.t - pad.b;
		const textMute = cssVar('--text-mute', '#6f8299');
		const coral = cssVar('--coral', '#f43f5e');
		const teal = cssVar('--teal', '#10b981');
		const cyan = cssVar('--cyan', '#06b6d4');
		const amber = cssVar('--amber', '#f59e0b');
		const palette = [coral, teal, cyan, amber, '#a78bfa'];

		const points = timeline.points;
		const x = (hh) => pad.l + (hh / 96) * iw;
		const y = (v) => pad.t + ih - (v / 100) * ih;

		ctx.clearRect(0, 0, w, h);
		ctx.fillStyle = withAlpha(textMute, 0.05);
		ctx.fillRect(pad.l, pad.t, iw, ih);

		// transmission windows
		const bands = [
			{ to: 16, color: withAlpha(teal, 0.1), label: '0–16 h' },
			{ to: 36, color: withAlpha(amber, 0.1), label: '16–36 h' },
			{ to: 96, color: withAlpha(coral, 0.09), label: '36 h+' }
		];
		let prev = 0;
		for (const b of bands) {
			ctx.fillStyle = b.color;
			ctx.fillRect(x(prev), pad.t, x(b.to) - x(prev), ih);
			drawAxisLabel(ctx, b.label, x(prev) + 4, pad.t + ih - 6, { color: withAlpha(textMute, 0.85), size: 7, baseline: 'bottom' });
			prev = b.to;
		}

		timeline.species.pathogens.forEach((p, i) => {
			ctx.beginPath();
			points.forEach((pt, idx) => {
				const X = x(pt.h);
				const Y = y(pt[p.key]);
				idx ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
			});
			ctx.strokeStyle = palette[i % palette.length];
			ctx.lineWidth = 1.5;
			ctx.stroke();
		});

		// current attachment marker
		const cx = x(clamp(attach.hours, 0, 96));
		ctx.strokeStyle = withAlpha(cyan, 0.9);
		ctx.setLineDash([2, 3]);
		ctx.beginPath();
		ctx.moveTo(cx, pad.t);
		ctx.lineTo(cx, pad.t + ih);
		ctx.stroke();
		ctx.setLineDash([]);
		ctx.fillStyle = cyan;
		ctx.beginPath();
		ctx.arc(cx, pad.t + ih - (risk.maxRisk / 100) * ih, 3.2, 0, Math.PI * 2);
		ctx.fill();
		drawAxisLabel(ctx, `${attach.hours.toFixed(1)} h`, clamp(cx + 4, pad.l + 4, w - 40), pad.t + 8, { color: cyan, size: 7.5 });

		for (const hh of [0, 24, 48, 72, 96]) {
			drawAxisLabel(ctx, `${hh}h`, x(hh), h - 5, { color: textMute, size: 7.5, align: hh === 0 ? 'left' : hh === 96 ? 'right' : 'center' });
		}
		for (const v of [0, 50, 100]) {
			drawAxisLabel(ctx, `${v}%`, pad.l - 4, y(v), { color: textMute, size: 7, align: 'right' });
		}
		drawAxisLabel(ctx, 'transmission competence', pad.l + 2, pad.t + 2, { color: withAlpha(textMute, 0.9), size: 7.5, baseline: 'top' });
	}

	/* ------------------------------------------------------------- mount ---- */
	onMount(() => {
		mounted = true;
		lens = createMacroLens(lensCanvas, { onError: (m) => console.warn('[vet-spectra] lens:', m) });
		if (lens) {
			refreshTexture();
			lens.setState({ zoom, edge, mode: 0, falseColor: falseColor ? 1 : 0 });
			lens.start();
		}
		drawTimeline();
		const ro = new ResizeObserver(() => drawTimeline());
		if (timelineCanvas) ro.observe(timelineCanvas);
		bumpVitals({ hr: 104 });
		return () => {
			ro.disconnect();
			lens?.destroy();
			lens = null;
			stopCamera();
		};
	});

	onDestroy(() => {
		lens?.destroy();
		lens = null;
		clearInterval(crtTimer);
		clearInterval(cameraTimer);
	});

	let textureToken = 0;
	$: if (mounted && lens) {
		// rebuild the procedural specimen whenever its geometry or the mode changes
		void [lengthMm, widthMm, lensMode, specimenKey, cameraOn];
		if (!cameraOn) {
			textureToken += 1;
			refreshTexture();
		}
	}

	$: if (lens) {
		void [zoom, edge, falseColor, lensMode];
		lens.setState({
			zoom,
			edge,
			falseColor: falseColor ? 1 : 0,
			mode: lensMode === 'gingiva' ? 1 : 0,
			uvOffset: [0, 0]
		});
	}

	$: if (mounted) {
		void [$theme, speciesKey, lengthMm, widthMm];
		drawTimeline();
	}

	/* ------------------------------------------------------------ camera ---- */
	async function toggleCamera() {
		if (cameraOn) return stopCamera();
		if (!can('hardware.camera')) {
			pushToast('Camera requires the Vet Tech tier — the procedural specimen stays available', 'warn');
			return;
		}
		try {
			stream = await navigator.mediaDevices.getUserMedia({
				video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } }
			});
			videoEl = document.createElement('video');
			videoEl.playsInline = true;
			videoEl.muted = true;
			videoEl.srcObject = stream;
			await videoEl.play();
			cameraOn = true;
			cameraTimer = setInterval(() => {
				if (lens && videoEl.readyState >= 2) lens.upload(videoEl);
			}, 120);
			pushToast('Macro camera streaming into the shader', 'ok');
		} catch {
			pushToast('Camera blocked — procedural specimen retained', 'warn');
		}
	}

	function stopCamera() {
		cameraOn = false;
		clearInterval(cameraTimer);
		cameraTimer = null;
		stream?.getTracks().forEach((t) => t.stop());
		stream = null;
		videoEl = null;
		refreshTexture();
	}

	/* --------------------------------------------------------------- CRT ---- */
	function toggleCrt() {
		if (!crtRunning) {
			crtRunning = true;
			crtStart = performance.now();
			crtTimer = setInterval(() => (crtSeconds = (performance.now() - crtStart) / 1000), 80);
		} else {
			crtRunning = false;
			crtSeconds = clamp((performance.now() - crtStart) / 1000, 0.1, 12);
			clearInterval(crtTimer);
		}
	}

	function applyGingivaPreset(key) {
		const presets = {
			normal: { L: 62, a: 30, b: 16, crt: 1.2 },
			gingivitis: { L: 58, a: 44, b: 22, crt: 1.6 },
			pallor: { L: 79, a: 18, b: 13, crt: 3.4 },
			icterus: { L: 66, a: 26, b: 38, crt: 1.8 },
			cyanosis: { L: 41, a: 22, b: 6, crt: 2.6 },
			congestion: { L: 47, a: 52, b: 21, crt: 2.2 }
		}[key];
		if (!presets) return;
		labL = presets.L;
		labA = presets.a;
		labB = presets.b;
		crtSeconds = presets.crt;
	}

	async function saveTick() {
		if (!can('vault.write')) {
			pushToast('Read-only tier — switch to Vet Tech to store the record', 'warn');
			return;
		}
		saving = true;
		try {
			const record = buildTickRecord({
				speciesKey,
				lengthMm,
				widthMm,
				patient: { name: $patient.name, species: $patient.species },
				notes: `SI ${si.toFixed(2)} · ${attach.hours.toFixed(1)} h · ${risk.band.label}`
			});
			const id = await saveClinicalRecord('tick_records', {
				...record,
				patientId: $patient.name,
				siValue: si,
				hoursAttached: attach.hours,
				riskLevel: risk.band.key,
				gingivaClass: gingiva.classKey,
				crt: crtSeconds,
				quoteVerdict: quote.verdict,
				quoteTotal: quotedTotal
			});
			savedId = id;
			refreshSyncState();
			pushToast(`Tick record committed · SI ${si.toFixed(2)} · ${attach.hours.toFixed(1)} h attached`, 'ok');
		} catch {
			pushToast('Vault write failed', 'bad');
		} finally {
			saving = false;
		}
	}

	function selectSpecimen(key) {
		specimenKey = key;
		const s = SPECIMEN_PRESETS.find((x) => x.key === key);
		if (s) {
			lengthMm = s.lengthMm;
			widthMm = s.widthMm;
		}
	}
</script>

<section class="module">
	<div class="module-head">
		<div>
			<h1 class="module-title">Tick Vector &amp; <em>Derma Auditor</em></h1>
			<p class="module-sub">
				Scutal index SI = body length ÷ scutum width, inverted through species-specific SI/time anchors to recover
				attachment duration, then mapped onto Ixodes / Dermacentor / Amblyomma / Rhipicephalus transmission
				windows. Gingival CIELAB classification with a CRT stopwatch, and an itemised veterinary billing auditor.
			</p>
		</div>
		<div class="row tight">
			<span class="badge info"><span class="dot"></span>SI {si.toFixed(2)}</span>
			<span class="badge {riskTone}"><span class="dot"></span>{risk.band.label}</span>
			<span class="badge {gingiva.tone === 'bad' ? 'bad' : gingiva.tone === 'warn' ? 'warn' : 'ok'}"><span class="dot"></span>{gingiva.classLabel.split('—')[0].trim()}</span>
		</div>
	</div>

	<div class="preset-grid">
		{#each TICK_SPECIES as s}
			<button class="preset" class:active={speciesKey === s.key} on:click={() => (speciesKey = s.key)} title={s.region}>
				<span class="p-name">{s.short}</span>
				<span class="p-desc">{s.region}</span>
			</button>
		{/each}
	</div>

	<div class="module-grid">
		<div class="col">
			<div class="card">
				<div class="card-head">
					<span class="card-title">{lensMode === 'tick' ? 'Scutal macro lens' : 'Gingival macro lens'}</span>
					<div class="row tight">
						<div class="seg">
							<button class:active={lensMode === 'tick'} on:click={() => (lensMode = 'tick')}>Scutum</button>
							<button class:active={lensMode === 'gingiva'} on:click={() => (lensMode = 'gingiva')}>Gingiva</button>
						</div>
						<button class="btn ghost mini" class:primary={cameraOn} on:click={toggleCamera}>
							{cameraOn ? '■ Stop cam' : '◎ Live cam'}
						</button>
					</div>
				</div>

				<div class="canvas-wrap lens-wrap">
					<canvas bind:this={lensCanvas} role="img" aria-label="WebGL macro lens view of the tick or gingiva"></canvas>
					{#if lensMode === 'tick'}
						<svg class="caliper" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
							<g>
								<line x1={50 - 26} y1="30" x2={50 + 26} y2="30" stroke="#06b6d4" stroke-width="0.4" stroke-dasharray="1.6 1.2" />
								<line x1={50 - 26} y1="27" x2={50 - 26} y2="33" stroke="#06b6d4" stroke-width="0.6" />
								<line x1={50 + 26} y1="27" x2={50 + 26} y2="33" stroke="#06b6d4" stroke-width="0.6" />
								<line x1="24" y1="30" x2="24" y2="76" stroke="#f43f5e" stroke-width="0.4" stroke-dasharray="1.6 1.2" />
								<line x1="21" y1="30" x2="27" y2="30" stroke="#f43f5e" stroke-width="0.6" />
								<line x1="21" y1="76" x2="27" y2="76" stroke="#f43f5e" stroke-width="0.6" />
							</g>
						</svg>
						<div class="caliper-label cal-w">W_scutum {widthMm.toFixed(2)} mm</div>
						<div class="caliper-label cal-l">L_body {lengthMm.toFixed(2)} mm</div>
					{/if}
					<div class="canvas-label">GLSL ES 3.00 · sobel margin · ring light</div>
					<div class="canvas-hud">
						<div>×{zoom.toFixed(1)} macro</div>
						<div>{cameraOn ? 'live camera' : 'procedural specimen'}</div>
					</div>
				</div>

				<div class="lens-controls">
					<div class="field">
						<span class="label">Body length · {lengthMm.toFixed(2)} mm</span>
						<input type="range" min="1" max="16" step="0.05" bind:value={lengthMm} />
					</div>
					<div class="field">
						<span class="label">Scutum width · {widthMm.toFixed(2)} mm</span>
						<input type="range" min="0.6" max="6" step="0.05" bind:value={widthMm} />
					</div>
					<div class="field">
						<span class="label">Macro zoom ×{zoom.toFixed(1)}</span>
						<input type="range" min="1" max="4" step="0.1" bind:value={zoom} />
					</div>
					<div class="field">
						<span class="label">Sobel edge gain</span>
						<input type="range" min="0" max="1" step="0.05" bind:value={edge} />
					</div>
				</div>

				<div class="row spread" style="margin-top:8px">
					<div class="row tight">
						{#each SPECIMEN_PRESETS as s}
							<button class="chip" class:active={specimenKey === s.key} on:click={() => selectSpecimen(s.key)} title={s.note}>
								{s.label.split('(')[0].trim()}
							</button>
						{/each}
					</div>
					<label class="switch">
						<input type="checkbox" bind:checked={falseColor} />
						<span class="track"></span>
						False colour
					</label>
				</div>
			</div>

			<div class="card">
				<div class="card-head">
					<span class="card-title">Gingival CIELAB &amp; capillary refill</span>
					<span class="badge {gingiva.tone === 'bad' ? 'bad' : gingiva.tone === 'warn' ? 'warn' : 'ok'}">
						<span class="dot"></span>{gingiva.classLabel}
					</span>
				</div>

				<div class="gingiva-layout">
					<div class="swatch-col">
						<div class="swatch" style={`background:${labToCss(labL, labA, labB)}`} aria-label="Sampled gingival colour"></div>
						<div class="swatch-meta mono">
							<div>L* {labL.toFixed(1)}</div>
							<div>a* {labA.toFixed(1)}</div>
							<div>b* {labB.toFixed(1)}</div>
							<div>C* {gingiva.chroma.toFixed(1)}</div>
						</div>
					</div>
					<div class="grow">
						<div class="field">
							<span class="label">L* lightness {labL.toFixed(0)}</span>
							<input type="range" min="25" max="92" step="0.5" bind:value={labL} />
						</div>
						<div class="field">
							<span class="label">a* red–green {labA.toFixed(0)}</span>
							<input type="range" min="5" max="60" step="0.5" bind:value={labA} />
						</div>
						<div class="field">
							<span class="label">b* yellow–blue {labB.toFixed(0)}</span>
							<input type="range" min="0" max="45" step="0.5" bind:value={labB} />
						</div>
					</div>
				</div>

				<div class="row tight" style="margin-top:8px">
					{#each GINGIVA_CLASSES as g}
						<button class="chip" on:click={() => applyGingivaPreset(g.key)}>{g.label.split('—')[0].trim()}</button>
					{/each}
				</div>

				<div class="crt-row">
					<button class="crt-btn" class:running={crtRunning} on:click={toggleCrt}>
						<span class="crt-time">{crtSeconds.toFixed(2)}</span>
						<span class="crt-hint">{crtRunning ? 'tap to stop' : 'CRT stopwatch'}</span>
					</button>
					<div class="grow">
						<div class="kv"><span class="k">Capillary refill</span><span class="v" class:coral={crtSeconds > 2}>{crtSeconds.toFixed(2)} s</span></div>
						<div class="kv"><span class="k">ΔE to reference</span><span class="v">{gingiva.deltaEToNormal.toFixed(1)}</span></div>
						<div class="verdict {gingiva.crtTone === 'bad' ? 'bad' : gingiva.crtTone === 'warn' ? 'warn' : 'info'}" style="margin-top:6px">
							<div class="med-icon {gingiva.crtTone === 'bad' ? 'bad' : 'warn'}">{gingiva.crtTone === 'ok' ? '✓' : '!'}</div>
							<div>
								<div class="verdict-title">{gingiva.classLabel}</div>
								<div class="verdict-body">{gingiva.crtVerdict}</div>
							</div>
						</div>
					</div>
				</div>

				<div class="action-list">
					{#each gingiva.actions as a}
						<div class="action-row"><span>▸</span>{a}</div>
					{/each}
				</div>
			</div>
		</div>

		<div class="col">
			<div class="card">
				<div class="card-head">
					<span class="card-title">Attachment duration &amp; risk</span>
					<span class="badge {riskTone}"><span class="dot"></span>{risk.window}</span>
				</div>

				<div class="attach-hero">
					<div class="metric">
						<span class="k">Estimated attachment</span>
						<span class="v {riskTone === 'bad' ? 'coral' : riskTone === 'warn' ? 'amber' : 'teal'}">
							{attach.hours.toFixed(1)}<small>h</small>
						</span>
					</div>
					<div class="si-box">
						<span class="mono si-num">{si.toFixed(2)}</span>
						<span class="si-cap">scutal<br />index</span>
					</div>
				</div>

				<div class="canvas-wrap" style="height:150px">
					<canvas bind:this={timelineCanvas} role="img" aria-label="Pathogen transmission competence by attachment hour"></canvas>
				</div>

				<div class="pathogen-list">
					{#each risk.pathogens as p}
						<div class="pathogen-row">
							<span class="path-dot" class:hi={p.level === 'high'} class:md={p.level === 'moderate'}></span>
							<div class="grow">
								<div class="row spread">
									<span class="path-label">{p.label}</span>
									<span class="mono tiny dim">{p.risk}%</span>
								</div>
								<div class="bar-meter" class:bad={p.risk >= 70} class:warn={p.risk >= 35 && p.risk < 70}>
									<i style={`width:${clamp(p.risk, 0, 100)}%`}></i>
								</div>
								<div class="path-note">{p.status} · threshold {p.thresholdH} h</div>
							</div>
						</div>
					{/each}
				</div>

				<div class="verdict {risk.tone === 'bad' ? 'bad' : risk.tone === 'warn' ? 'warn' : 'info'}" style="margin-top:9px">
					<div class="med-icon {risk.tone === 'bad' ? 'bad' : 'warn'}">{risk.tone === 'ok' ? '✓' : '!'}</div>
					<div>
						<div class="verdict-title">{risk.verdict}</div>
						<div class="verdict-body">{risk.species.label} · SI method: {attach.method.replace('-', ' ')}</div>
					</div>
				</div>

				<div class="action-list">
					{#each risk.actions as a}
						<div class="action-row"><span>▸</span>{a}</div>
					{/each}
				</div>

				{#if risk.highInoculation}
					<div class="badge bad" style="margin-top:8px"><span class="dot"></span>SI ≥ 2.5 — high-inoculation bite</div>
				{/if}

				<div class="row" style="margin-top:10px">
					<button class="btn primary mini grow" on:click={saveTick} disabled={saving}>
						{saving ? 'Writing…' : 'Commit tick record'}
					</button>
					{#if savedId}<span class="mono tiny mute">#{savedId}</span>{/if}
				</div>
			</div>

			<div class="card">
				<div class="card-head">
					<span class="card-title">Quote auditor</span>
					<span class="badge {quote.tone}"><span class="dot"></span>{quote.verdict}</span>
				</div>

				<div class="quote-grid">
					<div class="field">
						<span class="label">Procedure</span>
						<select bind:value={procedureKey}>
							{#each PROCEDURES as p}<option value={p.key}>{p.label}</option>{/each}
						</select>
					</div>
					<div class="field">
						<span class="label">Region</span>
						<select bind:value={regionKey}>
							{#each REGIONS as r}<option value={r.key}>{r.label} ×{r.index.toFixed(2)}</option>{/each}
						</select>
					</div>
					<div class="field">
						<span class="label">Quoted total</span>
						<input type="number" min="0" step="10" bind:value={quotedTotal} />
					</div>
					<div class="field">
						<span class="label">Insurance coverage %</span>
						<input type="number" min="0" max="100" step="5" bind:value={coveragePct} />
					</div>
				</div>

				<div class="field" style="margin-top:8px">
					<span class="label">Itemised lines — “description: amount”</span>
					<textarea bind:value={lineItemText} rows="4" spellcheck="false"></textarea>
				</div>

				<div class="fair-bar-wrap">
					<div class="row spread">
						<span class="tiny mute">fair {fmt(quote.fairLow, 0)} – {fmt(quote.fairHigh, 0)}</span>
						<span class="mono tiny">{quote.region.label}</span>
					</div>
					<div class="fair-bar">
						<span class="fair-zone"></span>
						<span
							class="fair-marker {quote.tone}"
							style={`left:${clamp(((quotedTotal - quote.fairLow * 0.6) / Math.max(1, quote.fairHigh * 1.6 - quote.fairLow * 0.6)) * 100, 0, 100)}%`}
						></span>
					</div>
					<div class="row spread tiny mute">
						<span>{fmt(quote.fairLow * 0.6, 0)}</span>
						<span class="mono">quoted {fmt(quotedTotal, 0)}</span>
						<span>{fmt(quote.fairHigh * 1.6, 0)}</span>
					</div>
				</div>

				<div class="flag-list">
					{#each quote.flags as f}
						<div class="flag-row {f.severity}">
							<span class="flag-mark">{f.severity === 'bad' ? '!' : f.severity === 'warn' ? '△' : '✓'}</span>
							<div>
								<div class="flag-title">{f.title}</div>
								<div class="flag-detail">{f.detail}</div>
							</div>
						</div>
					{/each}
				</div>

				<div class="divider"></div>

				<div class="metric-grid">
					<div class="metric"><span class="k">Allowed amount</span><span class="v">{fmt(quote.insurance.allowed, 0)}</span></div>
					<div class="metric"><span class="k">Reimbursement</span><span class="v teal">{fmt(quote.insurance.reimbursement, 0)}</span></div>
					<div class="metric"><span class="k">Out of pocket</span><span class="v coral">{fmt(quote.insurance.outOfPocket, 0)}</span></div>
					<div class="metric"><span class="k">vs midpoint</span><span class="v {quote.overMidPct > 25 ? 'coral' : quote.overMidPct > 0 ? 'amber' : 'teal'}">{quote.overMidPct > 0 ? '+' : ''}{fmt(quote.overMidPct, 0)}<small>%</small></span></div>
				</div>

				<div class="row tight" style="margin-top:8px">
					<input type="number" class="num-sm" min="0" bind:value={deductible} title="Deductible" />
					<span class="tiny mute">deductible</span>
					<input type="number" class="num-sm" min="0" max="1" step="0.05" bind:value={allowedFactor} title="Allowed factor" />
					<span class="tiny mute">allowed factor</span>
					<label class="switch" style="margin-left:auto">
						<input type="checkbox" bind:checked={emergency} />
						<span class="track"></span>
						Emergency
					</label>
				</div>

				<div class="includes">
					<div>
						<span class="label">Quoted procedure should include</span>
						<div class="inc-list">{quote.includes.join(' · ')}</div>
					</div>
					<div style="margin-top:7px">
						<span class="label">Watch for</span>
						<div class="inc-list warn">{quote.watchFor.join(' · ')}</div>
					</div>
				</div>
			</div>
		</div>
	</div>
</section>

<style>
	.lens-wrap {
		height: 268px;
	}

	.caliper {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
	}

	.caliper-label {
		position: absolute;
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: 0.04em;
		padding: 2px 5px;
		border-radius: 5px;
		background: color-mix(in srgb, var(--bg-0) 78%, transparent);
		border: 1px solid var(--stroke);
		pointer-events: none;
		white-space: nowrap;
	}

	.cal-w {
		top: 24%;
		left: 62%;
		color: var(--cyan);
	}

	.cal-l {
		top: 52%;
		left: 4%;
		color: var(--coral);
	}

	.lens-controls {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(136px, 1fr));
		gap: 8px;
		margin-top: 9px;
	}

	.attach-hero {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 8px;
	}

	.attach-hero .metric .v {
		font-size: 30px;
	}

	.si-box {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 5px 9px;
		border-radius: 11px;
		border: 1px solid var(--stroke-strong);
		background: color-mix(in srgb, var(--card-bg) 80%, transparent);
	}

	.si-num {
		font-size: 19px;
		font-weight: 800;
		color: var(--cyan);
		line-height: 1;
	}

	.si-cap {
		font-size: 7px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--text-mute);
		line-height: 1.2;
	}

	.pathogen-list {
		display: flex;
		flex-direction: column;
		gap: 7px;
		margin-top: 9px;
	}

	.pathogen-row {
		display: flex;
		gap: 8px;
		align-items: flex-start;
	}

	.path-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		margin-top: 5px;
		background: var(--ok);
		box-shadow: 0 0 8px var(--ok);
		flex: none;
	}

	.path-dot.md {
		background: var(--warn);
		box-shadow: 0 0 8px var(--warn);
	}

	.path-dot.hi {
		background: var(--bad);
		box-shadow: 0 0 8px var(--bad);
	}

	.path-label {
		font-size: 10px;
		font-weight: 650;
		color: var(--text);
	}

	.path-note {
		font-size: 8.5px;
		color: var(--text-mute);
		margin-top: 2px;
	}

	.action-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin-top: 8px;
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

	.gingiva-layout {
		display: flex;
		gap: 12px;
		align-items: flex-start;
	}

	.swatch-col {
		flex: none;
		display: flex;
		flex-direction: column;
		gap: 5px;
		align-items: center;
	}

	.swatch {
		width: 78px;
		height: 78px;
		border-radius: 14px;
		border: 1px solid var(--stroke-strong);
		box-shadow: inset 0 2px 12px rgba(0, 0, 0, 0.35), 0 8px 22px -14px #000;
		transition: background 0.3s ease;
	}

	.swatch-meta {
		font-size: 8.5px;
		line-height: 1.45;
		color: var(--text-mute);
		text-align: center;
	}

	.crt-row {
		display: flex;
		gap: 12px;
		align-items: center;
		margin-top: 10px;
	}

	.crt-btn {
		appearance: none;
		width: 78px;
		height: 78px;
		border-radius: 50%;
		border: 1.5px solid color-mix(in srgb, var(--coral) 45%, transparent);
		background: radial-gradient(circle at 34% 28%, color-mix(in srgb, var(--coral) 26%, transparent), transparent 72%);
		color: var(--text);
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1px;
		cursor: pointer;
		flex: none;
		transition: transform 0.18s var(--ease-spring), box-shadow 0.25s ease;
	}

	.crt-btn:active {
		transform: scale(0.94);
	}

	.crt-btn.running {
		box-shadow: 0 0 0 0 color-mix(in srgb, var(--coral) 45%, transparent);
		animation: crt-pulse 1.1s ease-out infinite;
	}

	@keyframes crt-pulse {
		0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--coral) 42%, transparent); }
		70% { box-shadow: 0 0 0 14px transparent; }
		100% { box-shadow: 0 0 0 0 transparent; }
	}

	.crt-time {
		font-family: var(--font-mono);
		font-size: 15px;
		font-weight: 800;
		color: var(--coral);
		line-height: 1;
	}

	.crt-hint {
		font-size: 6.5px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-mute);
	}

	.quote-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(126px, 1fr));
		gap: 8px;
	}

	.fair-bar-wrap {
		margin-top: 10px;
	}

	.fair-bar {
		position: relative;
		height: 8px;
		border-radius: 5px;
		background: color-mix(in srgb, var(--bg-0) 62%, transparent);
		border: 1px solid var(--stroke);
		margin: 5px 0 3px;
	}

	.fair-zone {
		position: absolute;
		left: 25%;
		width: 50%;
		top: 0;
		bottom: 0;
		background: linear-gradient(90deg, color-mix(in srgb, var(--teal) 55%, transparent), color-mix(in srgb, var(--cyan) 45%, transparent));
		border-radius: 5px;
	}

	.fair-marker {
		position: absolute;
		top: -4px;
		width: 3px;
		height: 16px;
		border-radius: 2px;
		background: var(--text);
		box-shadow: 0 0 8px var(--text);
		transform: translateX(-1.5px);
		transition: left 0.4s var(--ease-out);
	}

	.fair-marker.bad { background: var(--bad); box-shadow: 0 0 9px var(--bad); }
	.fair-marker.warn { background: var(--warn); box-shadow: 0 0 9px var(--warn); }
	.fair-marker.ok { background: var(--ok); box-shadow: 0 0 9px var(--ok); }

	.flag-list {
		display: flex;
		flex-direction: column;
		gap: 5px;
		margin-top: 9px;
	}

	.flag-row {
		display: flex;
		gap: 8px;
		padding: 7px 9px;
		border-radius: 9px;
		border: 1px solid var(--stroke);
		background: color-mix(in srgb, var(--card-bg) 55%, transparent);
	}

	.flag-row.bad { border-color: color-mix(in srgb, var(--bad) 42%, transparent); background: color-mix(in srgb, var(--bad) 9%, transparent); }
	.flag-row.warn { border-color: color-mix(in srgb, var(--warn) 40%, transparent); background: color-mix(in srgb, var(--warn) 8%, transparent); }
	.flag-row.ok { border-color: color-mix(in srgb, var(--ok) 38%, transparent); background: color-mix(in srgb, var(--ok) 8%, transparent); }

	.flag-mark {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 800;
		width: 13px;
		flex: none;
		color: var(--text-dim);
	}

	.flag-row.bad .flag-mark { color: var(--bad); }
	.flag-row.warn .flag-mark { color: var(--warn); }
	.flag-row.ok .flag-mark { color: var(--ok); }

	.flag-title {
		font-size: 10px;
		font-weight: 700;
		color: var(--text);
	}

	.flag-detail {
		font-size: 9.5px;
		line-height: 1.45;
		color: var(--text-mute);
		margin-top: 2px;
	}

	.num-sm {
		width: 62px;
		padding: 5px 7px;
		font-size: 10.5px;
	}

	.includes {
		margin-top: 10px;
		font-size: 9.5px;
		line-height: 1.5;
	}

	.inc-list {
		color: var(--text-dim);
		margin-top: 2px;
	}

	.inc-list.warn {
		color: color-mix(in srgb, var(--warn) 70%, var(--text-dim));
	}
</style>
