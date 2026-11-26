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
		AAHA_SCALE,
		analyzeGait,
		CSU_PAIN_ITEMS,
		FELINE_GRIMACE_ITEMS,
		GAIT_PROFILES,
		getGaitProfile,
		GRIMACE_THRESHOLD,
		LIMBS,
		scoreCsuPain,
		scoreFelineGrimace,
		stanceWindows
	} from '$lib/engines/quadrupedGaitKinematicsEngine.js';
	import { clamp, cssVar, drawAxisLabel, fmt, setupCanvas, withAlpha } from '$lib/utils/format.js';

	/* ------------------------------------------------------------- state -- */
	let profileKey = 'left_fore_3';
	let report = null;
	let seriesCanvas = null;
	let lissaCanvas = null;
	let avatarCanvas = null;
	let mounted = false;
	let raf = 0;
	let t0 = 0;
	let reduced = false;
	let csuValues = { q1: 2, q2: 1, q3: 1, q4: 0 };
	let grimaceValues = { ears: 1, orbital: 1, muzzle: 0, whiskers: 1, head: 0 };
	let species = 'dog';
	let saving = false;

	$: profile = getGaitProfile(profileKey);
	$: report = mounted ? analyzeGait(profileKey, { seconds: 6, fs: 120 }) : null;
	$: csu = scoreCsuPain(csuValues);
	$: grimace = scoreFelineGrimace(grimaceValues);
	$: pain = species === 'cat' ? grimace : csu;
	function laiTone(v) {
		return v >= 30 ? 'coral' : v >= 12 ? 'amber' : 'teal';
	}

	/* ------------------------------------------------------------ drawing -- */
	function drawSeries() {
		if (!seriesCanvas || !report) return;
		const setup = setupCanvas(seriesCanvas, 196);
		if (!setup) return;
		const { ctx, w, h } = setup;
		const pad = { l: 30, r: 10, t: 12, b: 18 };
		const iw = w - pad.l - pad.r;
		const ih = h - pad.t - pad.b;
		const teal = cssVar('--teal', '#10b981');
		const cyan = cssVar('--cyan', '#06b6d4');
		const coral = cssVar('--coral', '#f43f5e');
		const textMute = cssVar('--text-mute', '#6f8299');

		const { sim } = report;
		const n = sim.head.length;
		const maxStrides = 4;
		const limit = Math.min(n, Math.floor((maxStrides / sim.strideHz) * sim.fs));
		const all = [...sim.head.slice(0, limit), ...sim.pelvis.slice(0, limit)];
		const yMin = Math.min(...all) - 2;
		const yMax = Math.max(...all) + 2;
		const px = (i) => pad.l + (i / (limit - 1)) * iw;
		const py = (v) => pad.t + ih - ((v - yMin) / Math.max(1e-6, yMax - yMin)) * ih;

		ctx.clearRect(0, 0, w, h);
		ctx.fillStyle = withAlpha(textMute, 0.05);
		ctx.fillRect(pad.l, pad.t, iw, ih);

		// stride separators
		const framePerStride = sim.fs / sim.strideHz;
		for (let s = 0; s * framePerStride < limit; s++) {
			const x = px(Math.floor(s * framePerStride));
			ctx.strokeStyle = withAlpha(textMute, 0.14);
			ctx.beginPath();
			ctx.moveTo(x, pad.t);
			ctx.lineTo(x, pad.t + ih);
			ctx.stroke();
			if (s > 0) drawAxisLabel(ctx, `S${s}`, x, h - 6, { color: textMute, size: 7.5, align: 'center' });
		}

		const stroke = (data, color, width, dash = []) => {
			ctx.save();
			ctx.beginPath();
			for (let i = 0; i < limit; i++) {
				const X = px(i);
				const Y = py(data[i]);
				i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
			}
			ctx.strokeStyle = color;
			ctx.lineWidth = width;
			ctx.setLineDash(dash);
			ctx.lineJoin = 'round';
			ctx.shadowColor = color;
			ctx.shadowBlur = width > 1.4 ? 7 : 0;
			ctx.stroke();
			ctx.restore();
		};

		stroke(sim.pelvis.slice(0, limit), withAlpha(coral, 0.85), 1.4);
		stroke(sim.head.slice(0, limit), teal, 1.6);

		// harmonic reconstruction (1st + 2nd)
		const w0 = 2 * Math.PI * sim.strideHz;
		const recon = (stats) => {
			const out = [];
			for (let i = 0; i < limit; i++) {
				const t = i / sim.fs;
				out.push(
					stats.dc +
						stats.a1 * Math.cos(w0 * t - stats.phi1) +
						stats.a2 * Math.cos(2 * w0 * t - stats.phi2)
				);
			}
			return out;
		};
		stroke(recon(report.head), withAlpha(cyan, 0.85), 1.1, [4, 3]);
		stroke(recon(report.pelvis), withAlpha(cyan, 0.55), 1, [2, 4]);

		// axis
		for (const v of [yMin, (yMin + yMax) / 2, yMax]) {
			drawAxisLabel(ctx, `${v.toFixed(0)}`, pad.l - 5, py(v), { color: textMute, size: 7.5, align: 'right' });
		}
		drawAxisLabel(ctx, 'mm vertical excursion', pad.l + 2, pad.t + 2, {
			color: withAlpha(textMute, 0.9),
			size: 7.5,
			baseline: 'top'
		});

		// legend
		drawAxisLabel(ctx, '— head (poll)', pad.l + 4, pad.t + 12, { color: teal, size: 7.5 });
		drawAxisLabel(ctx, '— pelvis (tuber sacrale)', pad.l + 92, pad.t + 12, { color: coral, size: 7.5 });
		drawAxisLabel(ctx, '- - harmonic fit', pad.l + 226, pad.t + 12, { color: cyan, size: 7.5 });
	}

	function drawLissajous() {
		if (!lissaCanvas || !report) return;
		const setup = setupCanvas(lissaCanvas, 196);
		if (!setup) return;
		const { ctx, w, h } = setup;
		const teal = cssVar('--teal', '#10b981');
		const coral = cssVar('--coral', '#f43f5e');
		const textMute = cssVar('--text-mute', '#6f8299');
		const { sim } = report;
		const n = Math.min(sim.head.length, Math.floor((6 / sim.strideHz) * sim.fs));
		const margin = 22;
		const iw = w - margin * 2;
		const ih = h - margin * 2;

		const hMin = Math.min(...sim.head.slice(0, n));
		const hMax = Math.max(...sim.head.slice(0, n));
		const pMin = Math.min(...sim.pelvis.slice(0, n));
		const pMax = Math.max(...sim.pelvis.slice(0, n));

		ctx.clearRect(0, 0, w, h);
		ctx.strokeStyle = withAlpha(textMute, 0.16);
		ctx.strokeRect(margin, margin, iw, ih);
		ctx.beginPath();
		ctx.moveTo(margin + iw / 2, margin);
		ctx.lineTo(margin + iw / 2, margin + ih);
		ctx.moveTo(margin, margin + ih / 2);
		ctx.lineTo(margin + iw, margin + ih / 2);
		ctx.stroke();

		// butterfly trail
		for (let i = 1; i < n; i++) {
			const x1 = margin + ((sim.pelvis[i - 1] - pMin) / Math.max(1e-6, pMax - pMin)) * iw;
			const y1 = margin + ih - ((sim.head[i - 1] - hMin) / Math.max(1e-6, hMax - hMin)) * ih;
			const x2 = margin + ((sim.pelvis[i] - pMin) / Math.max(1e-6, pMax - pMin)) * iw;
			const y2 = margin + ih - ((sim.head[i] - hMin) / Math.max(1e-6, hMax - hMin)) * ih;
			const a = 0.12 + 0.6 * (i / n);
			ctx.strokeStyle = withAlpha(i % 2 ? teal : coral, a);
			ctx.lineWidth = 1.2;
			ctx.beginPath();
			ctx.moveTo(x1, y1);
			ctx.lineTo(x2, y2);
			ctx.stroke();
		}
		drawAxisLabel(ctx, 'head excursion →', 4, margin - 8, { color: withAlpha(teal, 0.85), size: 7.5 });
		drawAxisLabel(ctx, 'pelvis excursion →', w - 4, h - 5, { color: withAlpha(coral, 0.85), size: 7.5, align: 'right' });
		drawAxisLabel(ctx, `LAI ${report.dominantLAI.toFixed(1)} %`, w - 6, margin - 8, {
			color: report.dominantLAI >= 12 ? coral : teal,
			size: 8,
			align: 'right'
		});
	}

	function drawAvatar(now) {
		if (!avatarCanvas) return;
		const setup = setupCanvas(avatarCanvas, 196);
		if (!setup) return;
		const { ctx, w, h } = setup;
		const teal = cssVar('--teal', '#10b981');
		const coral = cssVar('--coral', '#f43f5e');
		const cyan = cssVar('--cyan', '#06b6d4');
		const textMute = cssVar('--text-mute', '#6f8299');
		const ground = h - 30;
		const cx = w / 2;
		const cy = ground - 62;
		const bodyW = Math.min(112, w * 0.36);
		const bodyH = 30;
		const phase = ((now - t0) / 1000) * profile.strideHz;
		const windows = stanceWindows(profile);

		ctx.clearRect(0, 0, w, h);

		// ground + gait ticks
		ctx.strokeStyle = withAlpha(textMute, 0.28);
		ctx.beginPath();
		ctx.moveTo(0, ground + 0.5);
		ctx.lineTo(w, ground + 0.5);
		ctx.stroke();
		for (let i = 0; i < 18; i++) {
			const x = (i / 18) * w;
			ctx.fillStyle = withAlpha(textMute, 0.2);
			ctx.fillRect(x, ground + 1, 1, 5);
		}

		const bodyBob = Math.sin(phase * Math.PI * 2) * 2.6;
		// torso
		ctx.save();
		ctx.translate(cx, cy + bodyBob);
		ctx.fillStyle = withAlpha(teal, 0.16);
		ctx.strokeStyle = withAlpha(teal, 0.75);
		ctx.lineWidth = 1.6;
		ctx.beginPath();
		ctx.ellipse(0, 0, bodyW / 2, bodyH / 2, 0, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();

		// neck + head with nod
		const nod = Math.sin(phase * Math.PI * 2 + Math.PI) * (profile.head.a1 / 8) * 4;
		const headX = -bodyW / 2 - 22;
		const headY = -26 - nod * 0.35;
		ctx.strokeStyle = withAlpha(teal, 0.8);
		ctx.lineWidth = 5;
		ctx.lineCap = 'round';
		ctx.beginPath();
		ctx.moveTo(-bodyW / 2 + 4, -6);
		ctx.lineTo(headX + 12, headY + 8);
		ctx.stroke();
		ctx.fillStyle = withAlpha(teal, 0.22);
		ctx.strokeStyle = withAlpha(teal, 0.85);
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.ellipse(headX, headY, 15, 11, -0.28, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();
		// muzzle + ear
		ctx.beginPath();
		ctx.moveTo(headX - 13, headY + 2);
		ctx.lineTo(headX - 24, headY + 7);
		ctx.stroke();
		ctx.beginPath();
		ctx.moveTo(headX + 6, headY - 9);
		ctx.lineTo(headX + 2, headY - 22);
		ctx.lineTo(headX + 12, headY - 10);
		ctx.closePath();
		ctx.fillStyle = withAlpha(teal, 0.35);
		ctx.fill();
		ctx.stroke();

		// tail
		ctx.strokeStyle = withAlpha(teal, 0.65);
		ctx.lineWidth = 3.4;
		ctx.beginPath();
		ctx.moveTo(bodyW / 2 - 4, -4);
		ctx.quadraticCurveTo(bodyW / 2 + 20, -18, bodyW / 2 + 26, -2 + Math.sin(phase * 2) * 5);
		ctx.stroke();
		ctx.restore();

		// legs
		const offsets = { LF: -bodyW * 0.3, RF: -bodyW * 0.18, LH: bodyW * 0.26, RH: bodyW * 0.38 };
		for (const limb of LIMBS) {
			const win = windows.find((x) => x.key === limb.key);
			const p = (phase + limb.phase) % 1;
			const inStance = p < win.duty;
			const swing = inStance ? 0 : (p - win.duty) / Math.max(0.05, 1 - win.duty);
			const lift = inStance ? 0 : Math.sin(Math.PI * swing) * 17;
			const forward = inStance ? (0.5 - p / win.duty) * 8 : (0.5 - swing) * 14;
			const hipX = cx + offsets[limb.key];
			const hipY = cy + bodyBob + bodyH * 0.3;
			const footX = hipX + forward;
			const footY = ground - lift;
			const kneeX = (hipX + footX) / 2 + (limb.group === 'hind' ? -4 : 3);
			const kneeY = (hipY + footY) / 2;
			const isFar = limb.key === 'RF' || limb.key === 'RH';
			const color = win.isLame ? coral : isFar ? withAlpha(teal, 0.42) : withAlpha(teal, 0.85);

			ctx.strokeStyle = color;
			ctx.lineWidth = win.isLame ? 3.2 : 2.4;
			ctx.lineCap = 'round';
			ctx.beginPath();
			ctx.moveTo(hipX, hipY);
			ctx.lineTo(kneeX, kneeY);
			ctx.lineTo(footX, footY);
			ctx.stroke();
			ctx.fillStyle = color;
			ctx.beginPath();
			ctx.arc(footX, footY, 2.6, 0, Math.PI * 2);
			ctx.fill();
			if (win.isLame) {
				const pulse = 1 + Math.sin((now - t0) / 220) * 0.22;
				ctx.strokeStyle = withAlpha(coral, 0.5);
				ctx.lineWidth = 1.2;
				ctx.beginPath();
				ctx.arc(footX, footY - 4, 9 * pulse, 0, Math.PI * 2);
				ctx.stroke();
				drawAxisLabel(ctx, 'LAME', footX + 8, footY - 10, { color: coral, size: 7.5 });
			}
		}

		// phase ribbon
		const rx = 22;
		const rw = w - 44;
		const ry = 14;
		ctx.fillStyle = withAlpha(textMute, 0.16);
		ctx.fillRect(rx, ry, rw, 5);
		for (const win of windows) {
			const sx = rx + ((phase + LIMBS.find((l) => l.key === win.key).phase) % 1) * rw;
			if (win.isLame) {
				ctx.fillStyle = coral;
				ctx.fillRect(sx - 1.5, ry - 2, 3, 9);
			}
		}
		drawAxisLabel(ctx, 'stance phase · red = lame limb', rx, ry + 16, { color: textMute, size: 7.5 });

		// gait label
		drawAxisLabel(ctx, `${profile.strideHz.toFixed(1)} Hz stride`, w - 22, h - 8, {
			color: withAlpha(cyan, 0.8),
			size: 8,
			align: 'right'
		});
	}

	function loop(now) {
		if (!reduced) drawAvatar(now);
		raf = requestAnimationFrame(loop);
	}

	$: if (mounted) {
		void [$theme, report, profileKey, species];
		drawSeries();
		drawLissajous();
		if (reduced) drawAvatar(performance.now());
	}

	onMount(() => {
		mounted = true;
		t0 = performance.now();
		reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
		drawSeries();
		drawLissajous();
		drawAvatar(t0);
		if (!reduced) raf = requestAnimationFrame(loop);
		const ro = new ResizeObserver(() => {
			drawSeries();
			drawLissajous();
			drawAvatar(performance.now());
		});
		[seriesCanvas, lissaCanvas, avatarCanvas].forEach((c) => c && ro.observe(c));
		bumpVitals({ hr: 110 });
		return () => {
			ro.disconnect();
			cancelAnimationFrame(raf);
		};
	});

	onDestroy(() => cancelAnimationFrame(raf));

	/* ------------------------------------------------------------ actions -- */
	function chooseProfile(key) {
		profileKey = key;
		t0 = performance.now();
		pushToast(`Loaded ${getGaitProfile(key).short} inertial profile`, 'ok');
	}

	async function saveReport() {
		if (!can('vault.write')) {
			pushToast('Read-only tier — switch to Vet Tech to store the report', 'warn');
			return;
		}
		if (!report) return;
		saving = true;
		try {
			await saveClinicalRecord('gait_reports', {
				patientId: $patient.name,
				species,
				profile: profileKey,
				lai: Number(report.dominantLAI.toFixed(2)),
				headLAI: Number(report.head.lai.toFixed(2)),
				pelvisLAI: Number(report.pelvis.lai.toFixed(2)),
				limb: report.limbKey,
				aaha: report.aaha.score,
				asymmetryTiming: report.asymmetryTiming,
				deltaZmax: report.deltaZmax,
				deltaZmin: report.deltaZmin,
				csu: csu.total,
				grimace: grimace.total
			});
			refreshSyncState();
			pushToast('Gait report committed to the vault', 'ok');
		} catch {
			pushToast('Vault write failed', 'bad');
		} finally {
			saving = false;
		}
	}

	const harmonicRows = (stats) =>
		stats.harmonics.map((h) => ({ n: h.n, amp: h.amp, phase: (h.phase * 180) / Math.PI }));
</script>

<section class="module">
	<div class="module-head">
		<div>
			<h1 class="module-title">Quadruped <em>Gait Scanner</em></h1>
			<p class="module-sub">
				Poll and tuber-sacrale accelerometry decomposed at the stride frequency. LAI = A1 ÷ (A1 + A2), the
				vector-sum magnitude, ΔZmax/ΔZmin of the affected limb, phase-based localisation of which of the four
				limbs is unloading, impact-versus-push-off timing and an AAHA 0–5 grade.
			</p>
		</div>
		<div class="row tight">
			<span class="badge info"><span class="dot"></span>{profile.short}</span>
			<span class="badge {report && report.dominantLAI >= 12 ? 'bad' : 'ok'}"><span class="dot"></span>AAHA {report?.aaha.score ?? 0}/5</span>
			<span class="badge violet"><span class="dot"></span>120 Hz IMU</span>
		</div>
	</div>

	<div class="preset-grid">
		{#each GAIT_PROFILES as p}
			<button class="preset" class:active={profileKey === p.key} on:click={() => chooseProfile(p.key)} title={p.note}>
				<span class="p-name">{p.short}</span>
				<span class="p-desc">{p.strideHz.toFixed(1)} Hz · duty {(p.duty * 100).toFixed(0)}% · {p.lameLimb ?? 'symmetric'}</span>
			</button>
		{/each}
	</div>

	<div class="module-grid wide-left">
		<div class="col">
			<div class="card">
				<div class="card-head">
					<span class="card-title">Vertical excursion · 4 strides</span>
					<span class="mono tiny dim">
						{report ? `head A1 ${report.head.a1.toFixed(1)} / A2 ${report.head.a2.toFixed(1)} mm` : '—'}
					</span>
				</div>
				<div class="canvas-wrap" style="height:196px">
					<canvas bind:this={seriesCanvas} role="img" aria-label="Head and pelvis vertical excursion over four strides"></canvas>
				</div>
			</div>

			<div class="row even-gap">
				<div class="card grow">
					<div class="card-head"><span class="card-title">Head × pelvis phase portrait</span></div>
					<div class="canvas-wrap" style="height:196px">
						<canvas bind:this={lissaCanvas} role="img" aria-label="Lissajous phase portrait of head against pelvis"></canvas>
					</div>
				</div>
				<div class="card grow">
					<div class="card-head">
						<span class="card-title">Live quadruped</span>
						<span class="badge info">{profile.strideHz.toFixed(1)} Hz</span>
					</div>
					<div class="canvas-wrap" style="height:196px">
						<canvas bind:this={avatarCanvas} role="img" aria-label="Animated quadruped gait avatar"></canvas>
					</div>
				</div>
			</div>

			<div class="card">
				<div class="card-head">
					<span class="card-title">Harmonic decomposition</span>
					<span class="mono tiny dim">f0 = {report ? report.sim.strideHz.toFixed(2) : '—'} Hz</span>
				</div>
				<table class="dtable">
					<thead>
						<tr><th>Harmonic</th><th>Head amp</th><th>Head φ</th><th>Pelvis amp</th><th>Pelvis φ</th></tr>
					</thead>
					<tbody>
						{#if report}
							{#each harmonicRows(report.head) as h, i}
								<tr>
									<td class="strong">H{h.n} · {(h.n * report.sim.strideHz).toFixed(1)} Hz</td>
									<td class="num">{h.amp.toFixed(2)} mm</td>
									<td class="num">{h.phase.toFixed(0)}°</td>
									<td class="num">{report.pelvis.harmonics[i].amp.toFixed(2)} mm</td>
									<td class="num">{((report.pelvis.harmonics[i].phase * 180) / Math.PI).toFixed(0)}°</td>
								</tr>
							{/each}
						{/if}
					</tbody>
				</table>
			</div>
		</div>

		<div class="col">
			<div class="card">
				<div class="card-head">
					<span class="card-title">Lameness asymmetry</span>
					<span class="badge {report && report.dominantLAI >= 12 ? 'bad' : 'ok'}">
						<span class="dot"></span>{report && report.dominantLAI >= 12 ? 'asymmetric' : 'symmetric'}
					</span>
				</div>
				{#if report}
					<div class="lai-hero">
						<div class="metric">
							<span class="k">Dominant LAI ({report.dominant})</span>
							<span class="v {laiTone(report.dominantLAI)}">{report.dominantLAI.toFixed(1)}<small>%</small></span>
						</div>
						<div class="aaha-badge">
							<span class="aaha-num">{report.aaha.score}</span>
							<span class="aaha-label">AAHA<br />grade</span>
						</div>
					</div>
					<div class="zone-bar" style="margin-bottom:10px">
						{#each [{ max: 6, t: 'ok' }, { max: 12, t: 'ok' }, { max: 20, t: 'warn' }, { max: 30, t: 'warn' }, { max: 45, t: 'bad' }, { max: 100, t: 'bad' }] as z, i}
							<span class="hot" style={`background:var(--${z.t === 'ok' ? 'ok' : z.t === 'warn' ? 'warn' : 'bad'}); opacity:${i === Math.min(5, report.aaha.score) ? 1 : 0.28}`}></span>
						{/each}
					</div>
					<div class="kv"><span class="k">Localised limb</span><span class="v">{LIMBS.find((l) => l.key === report.limbKey)?.label}</span></div>
					<div class="kv"><span class="k">Phase-derived limb</span><span class="v">{LIMBS.find((l) => l.key === report.phaseLimb)?.label ?? 'not localisable (LAI < 6 %)'}</span></div>
					<div class="kv"><span class="k">Asymmetry timing</span><span class="v">{report.asymmetryTiming}</span></div>
					<div class="kv"><span class="k">Stance asymmetry</span><span class="v">{report.stanceAsymmetryPct.toFixed(1)} %</span></div>
					<div class="kv"><span class="k">ΔZmax / ΔZmin</span><span class="v">{report.deltaZmax.toFixed(1)} / {report.deltaZmin.toFixed(1)} mm</span></div>
					<div class="kv"><span class="k">Head vector sum</span><span class="v">{report.head.vectorSum.toFixed(2)} mm</span></div>
					<div class="kv"><span class="k">Pelvis vector sum</span><span class="v">{report.pelvis.vectorSum.toFixed(2)} mm</span></div>
					<div class="verdict {report.aaha.score >= 3 ? 'bad' : report.aaha.score >= 1 ? 'warn' : 'info'}" style="margin-top:10px">
						<div class="med-icon {report.aaha.score >= 3 ? 'bad' : 'warn'}">{report.aaha.score}</div>
						<div>
							<div class="verdict-title">{report.aaha.label}</div>
							<div class="verdict-body">{report.aaha.desc}</div>
						</div>
					</div>
					<div class="row" style="margin-top:10px">
						<button class="btn primary mini grow" on:click={saveReport} disabled={saving}>
							{saving ? 'Writing…' : 'Commit gait report'}
						</button>
					</div>
				{/if}
			</div>

			<div class="card">
				<div class="card-head">
					<span class="card-title">Pain scoring</span>
					<div class="seg">
						<button class:active={species === 'dog'} on:click={() => (species = 'dog')}>CSU canine</button>
						<button class:active={species === 'cat'} on:click={() => (species = 'cat')}>Feline grimace</button>
					</div>
				</div>

				{#if species === 'dog'}
					<div class="pain-list">
						{#each CSU_PAIN_ITEMS as item}
							<div class="pain-row">
								<span class="pain-label">{item.label}</span>
								<div class="seg tiny-seg">
									{#each [0, 1, 2, 3, 4] as v}
										<button
											class:active={csuValues[item.key] === v}
											on:click={() => (csuValues = { ...csuValues, [item.key]: v })}
											title={item.anchors[v]}
										>{v}</button>
									{/each}
								</div>
							</div>
						{/each}
					</div>
					<div class="row spread" style="margin-top:8px">
						<span class="mono tiny">CSU total {csu.total}/16</span>
						<span class="badge {csu.intervene ? 'warn' : 'ok'}"><span class="dot"></span>{csu.band}</span>
					</div>
					<p class="tiny mute" style="margin-top:6px">{csu.recommendation}</p>
				{:else}
					<div class="pain-list">
						{#each FELINE_GRIMACE_ITEMS as item}
							<div class="pain-row">
								<span class="pain-label">{item.label}</span>
								<div class="seg tiny-seg">
									{#each [0, 1, 2] as v}
										<button
											class:active={grimaceValues[item.key] === v}
											on:click={() => (grimaceValues = { ...grimaceValues, [item.key]: v })}
											title={item.anchors[v]}
										>{v}</button>
									{/each}
								</div>
							</div>
						{/each}
					</div>
					<div class="row spread" style="margin-top:8px">
						<span class="mono tiny">FGS {grimace.total}/10 · {(grimace.normalised * 100).toFixed(0)}%</span>
						<span class="badge {grimace.painPresent ? 'bad' : 'ok'}"><span class="dot"></span>{grimace.band}</span>
					</div>
					<p class="tiny mute" style="margin-top:6px">{grimace.recommendation}</p>
				{/if}
			</div>

			<div class="card">
				<div class="card-head">
					<span class="card-title">AAHA lameness scale</span>
					<span class="mono tiny dim">0 → 5</span>
				</div>
				<div class="aaha-list">
					{#each AAHA_SCALE as s}
						<div class="aaha-row" class:on={report?.aaha.score === s.score}>
							<span class="aaha-idx">{s.score}</span>
							<div class="grow">
								<div class="aaha-name">{s.label}</div>
								<div class="aaha-desc">{s.desc}</div>
							</div>
						</div>
					{/each}
				</div>
			</div>
		</div>
	</div>
</section>

<style>
	.even-gap {
		gap: 12px;
		align-items: stretch;
	}

	.even-gap > .card {
		min-width: 0;
	}

	.lai-hero {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 10px;
	}

	.lai-hero .metric .v {
		font-size: 32px;
	}

	.aaha-badge {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 6px 10px;
		border-radius: 12px;
		border: 1px solid var(--stroke-strong);
		background: color-mix(in srgb, var(--card-bg) 80%, transparent);
	}

	.aaha-num {
		font-family: var(--font-mono);
		font-size: 24px;
		font-weight: 800;
		line-height: 1;
		color: var(--teal);
	}

	.aaha-label {
		font-size: 7.5px;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--text-mute);
		line-height: 1.3;
	}

	.pain-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.pain-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.pain-label {
		font-size: 10px;
		color: var(--text-dim);
		line-height: 1.3;
	}

	.tiny-seg button {
		padding: 4px 7px;
		font-size: 9.5px;
		min-width: 22px;
		justify-content: center;
	}

	.aaha-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.aaha-row {
		display: flex;
		gap: 9px;
		padding: 5px 7px;
		border-radius: 9px;
		border: 1px solid transparent;
		opacity: 0.62;
		transition: all 0.25s ease;
	}

	.aaha-row.on {
		opacity: 1;
		border-color: color-mix(in srgb, var(--teal) 40%, transparent);
		background: color-mix(in srgb, var(--teal) 9%, transparent);
	}

	.aaha-idx {
		width: 18px;
		height: 18px;
		border-radius: 6px;
		display: grid;
		place-items: center;
		font-family: var(--font-mono);
		font-size: 9.5px;
		font-weight: 700;
		color: var(--text-dim);
		background: color-mix(in srgb, var(--bg-0) 45%, transparent);
		border: 1px solid var(--stroke);
		flex: none;
	}

	.aaha-row.on .aaha-idx {
		background: var(--teal);
		color: #04120e;
		border-color: var(--teal);
	}

	.aaha-name {
		font-size: 10px;
		font-weight: 700;
		color: var(--text);
	}

	.aaha-desc {
		font-size: 9px;
		color: var(--text-mute);
		line-height: 1.4;
		margin-top: 1px;
	}
</style>
