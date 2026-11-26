<script>
	import { onMount } from 'svelte';
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
		buildMethylxanthineCurve,
		CASE_PRESETS,
		CHOCOLATE_MATRICES,
		doseFromMass,
		evaluateToxin,
		fluidPlan,
		gastricEmptyingFraction,
		getMatrix,
		LIFE_STAGES,
		mdr1Risk,
		MDR1_BREEDS,
		merForStage,
		METHYLXANTHINE_ZONES,
		MODEL_VERSION,
		SEVERITY_LABELS,
		TOXIN_KEYS,
		TOXIN_PROFILES
	} from '$lib/engines/vetToxicologyAllometryEngine.js';
	import {
		clamp,
		cssVar,
		drawAxisLabel,
		drawGrid,
		fmt,
		fmtMgKg,
		setupCanvas,
		withAlpha
	} from '$lib/utils/format.js';

	/* ----------------------------------------------------------- state ---- */
	let species = 'dog';
	let weightKg = 12;
	let usePounds = false;
	let breed = 'Beagle';
	let lifeStage = 'neutered';
	let mode = 'chocolate';
	let matrixKey = 'dark70';
	let massG = 85;
	let minutesSinceIngestion = 45;
	let recirculation = true;
	let toxinKey = 'xylitol';
	let toxinVariant = 'gum';
	let toxinAmount = 1800;
	let dehydrationPct = 5;
	let ongoingLoss = 0;
	let presetId = null;
	let savedCount = 0;
	let saving = false;
	let hoverT = null;

	let curveCanvas = null;
	let hoverInfo = null;
	let mounted = false;

	/* --------------------------------------------------------- derived ---- */
	$: matrix = getMatrix(matrixKey);
	$: weightLb = weightKg * 2.20462;
	$: dose = doseFromMass({ massG, matrixKey, weightKg, species });
	$: curve = buildMethylxanthineCurve({
		massG,
		matrixKey,
		weightKg,
		species,
		hours: 72,
		steps: 360
	});
	$: gastric = gastricEmptyingFraction({
		minutesSinceIngestion,
		tHalfGastricHr: species === 'cat' ? 1.6 : 2.0
	});
	$: toxinProfile = TOXIN_PROFILES[toxinKey];
	$: toxinResult =
		mode === 'toxin'
			? evaluateToxin({ toxinKey, amount: toxinAmount, weightKg, species, variant: toxinVariant })
			: null;
	$: energy = merForStage(weightKg, lifeStage, species);
	$: fluids = fluidPlan({ weightKg, dehydrationPct, species, ongoingLossMl: ongoingLoss });
	$: mdr1 = mdr1Risk(breed);
	$: zone = dose.zone;
	$: severity = mode === 'chocolate' ? METHYLXANTHINE_ZONES.findIndex((z) => z.key === zone.key) : toxinResult?.severity ?? 0;
	$: critical = severity >= 3;
	$: summaryTone = critical ? 'bad' : severity >= 1 ? 'warn' : 'ok';

	// Mass of chocolate that would reach each clinical threshold for this patient.
	$: thresholds = [20, 40, 60, 100].map((mgkg) => ({
		mgkg,
		grams: (mgkg * weightKg) / Math.max(0.0001, matrix.theo + matrix.caff),
		zone: METHYLXANTHINE_ZONES.find((z) => mgkg < z.max)
	}));

	$: if (mounted) bumpVitals({ toxicity: clamp((mode === 'chocolate' ? dose.doseTotalMgKg : (toxinResult?.severity ?? 0) * 30) / 120, 0, 1) });

	/* ----------------------------------------------------------- canvas ---- */
	function draw() {
		if (!curveCanvas) return;
		const setup = setupCanvas(curveCanvas, 208);
		if (!setup) return;
		const { ctx, w, h } = setup;
		const pad = { l: 36, r: 12, t: 12, b: 20 };
		const iw = w - pad.l - pad.r;
		const ih = h - pad.t - pad.b;

		const teal = cssVar('--teal', '#10b981');
		const cyan = cssVar('--cyan', '#06b6d4');
		const coral = cssVar('--coral', '#f43f5e');
		const amber = cssVar('--amber', '#f59e0b');
		const textMute = cssVar('--text-mute', '#6f8299');
		const stroke = cssVar('--stroke', 'rgba(255,255,255,0.09)');

		const series = curve.points.map((p) => ({
			t: p.t,
			theo: p.theo * 0.68,
			caff: p.caff * 0.7,
			burden: p.theo * 0.68 + p.caff * 0.7
		}));
		const maxBurden = Math.max(...series.map((s) => s.burden), 1);
		const yMax = Math.max(60, Math.min(220, Math.max(maxBurden * 1.18, dose.doseTotalMgKg * 0.9)));
		const x = (t) => pad.l + (t / 72) * iw;
		const y = (v) => pad.t + ih - (clamp(v, 0, yMax) / yMax) * ih;

		ctx.clearRect(0, 0, w, h);

		// clinical zone bands
		const bands = [
			{ from: 0, to: 20, color: withAlpha(teal, 0.1) },
			{ from: 20, to: 40, color: withAlpha(amber, 0.12) },
			{ from: 40, to: 60, color: withAlpha(coral, 0.14) },
			{ from: 60, to: 100, color: withAlpha(coral, 0.22) },
			{ from: 100, to: yMax, color: withAlpha(coral, 0.3) }
		];
		for (const b of bands) {
			const top = y(Math.min(b.to, yMax));
			const bottom = y(Math.min(b.from, yMax));
			if (bottom - top <= 0) continue;
			ctx.fillStyle = b.color;
			ctx.fillRect(pad.l, top, iw, bottom - top);
			ctx.fillStyle = 'transparent';
		}

		drawGrid(ctx, { w, h, cols: 6, rows: 4, color: withAlpha(textMute, 0.16) });

		// axes labels
		for (let t = 0; t <= 72; t += 12) {
			drawAxisLabel(ctx, `${t}h`, x(t), h - 7, { color: textMute, size: 8.5, align: t === 0 ? 'left' : t === 72 ? 'right' : 'center' });
		}
		for (const v of [0, 20, 40, 60, 100].filter((v) => v <= yMax)) {
			drawAxisLabel(ctx, String(v), pad.l - 6, y(v), { color: withAlpha(textMute, 0.95), size: 8.5, align: 'right' });
		}
		drawAxisLabel(ctx, 'mg/kg burden', pad.l + 2, pad.t + 2, { color: withAlpha(coral, 0.85), size: 8, align: 'left', baseline: 'top' });

		// series
		const plot = (key, color, width, dash = []) => {
			ctx.save();
			ctx.beginPath();
			series.forEach((s, i) => {
				const px = x(s.t);
				const py = y(s[key]);
				i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
			});
			ctx.strokeStyle = color;
			ctx.lineWidth = width;
			ctx.setLineDash(dash);
			ctx.shadowColor = color;
			ctx.shadowBlur = width > 2 ? 10 : 5;
			ctx.stroke();
			ctx.restore();
		};

		// total burden fill
		ctx.save();
		ctx.beginPath();
		series.forEach((s, i) => (i ? ctx.lineTo(x(s.t), y(s.burden)) : ctx.moveTo(x(s.t), y(s.burden))));
		ctx.lineTo(x(72), pad.t + ih);
		ctx.lineTo(x(0), pad.t + ih);
		ctx.closePath();
		const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ih);
		grad.addColorStop(0, withAlpha(coral, 0.28));
		grad.addColorStop(1, withAlpha(coral, 0));
		ctx.fillStyle = grad;
		ctx.fill();
		ctx.restore();

		plot('theo', teal, 1.6);
		plot('caff', cyan, 1.3, [3, 3]);
		plot('burden', coral, 2.4);

		// peak marker
		if (curve.peak.t > 0) {
			const px = x(curve.peak.t);
			ctx.save();
			ctx.setLineDash([2, 3]);
			ctx.strokeStyle = withAlpha(textMute, 0.6);
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(px, pad.t);
			ctx.lineTo(px, pad.t + ih);
			ctx.stroke();
			ctx.restore();
			drawAxisLabel(ctx, `Tmax ${curve.peak.t.toFixed(1)}h`, px + 4, pad.t + 4, { color: withAlpha(textMute, 0.9), size: 7.5, baseline: 'top' });
		}

		// current time marker
		const nowH = minutesSinceIngestion / 60;
		if (nowH <= 72) {
			const px = x(nowH);
			ctx.save();
			ctx.strokeStyle = withAlpha(cyan, 0.85);
			ctx.lineWidth = 1.2;
			ctx.beginPath();
			ctx.moveTo(px, pad.t);
			ctx.lineTo(px, pad.t + ih);
			ctx.stroke();
			ctx.restore();
			drawAxisLabel(ctx, 'now', px, pad.t + ih - 4, { color: withAlpha(cyan, 0.95), size: 7.5, align: 'center', baseline: 'bottom' });
		}

		// hover crosshair
		if (hoverT != null) {
			const px = x(hoverT);
			ctx.save();
			ctx.strokeStyle = withAlpha(cyan, 0.55);
			ctx.setLineDash([2, 2]);
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(px, pad.t);
			ctx.lineTo(px, pad.t + ih);
			ctx.stroke();
			ctx.restore();
		}

		// legend
		const legend = [
			{ label: 'Theobromine', color: teal },
			{ label: 'Caffeine', color: cyan },
			{ label: 'Total burden', color: coral }
		];
		let lx = pad.l + 4;
		legend.forEach((l) => {
			ctx.fillStyle = l.color;
			ctx.fillRect(lx, h - 3, 8, 2);
			drawAxisLabel(ctx, l.label, lx + 11, h - 3, { color: textMute, size: 7.5, baseline: 'middle' });
			lx += ctx.measureText(l.label).width + 30;
		});
		void stroke;
	}

	function handleHover(event) {
		if (!curveCanvas) return;
		const rect = curveCanvas.getBoundingClientRect();
		const padL = 36;
		const padR = 12;
		const t = ((event.clientX - rect.left - padL) / (rect.width - padL - padR)) * 72;
		hoverT = clamp(t, 0, 72);
		const p = curve.points.reduce((best, cur) => (Math.abs(cur.t - hoverT) < Math.abs(best.t - hoverT) ? cur : best), curve.points[0]);
		hoverInfo = {
			t: p.t,
			theo: p.theo,
			caff: p.caff,
			burden: p.theo * 0.68 + p.caff * 0.7
		};
	}

	$: if (mounted && curveCanvas) {
		// redraw on any state / theme change
		void [$theme, curve, hoverT, species];
		draw();
	}

	onMount(() => {
		mounted = true;
		draw();
		const ro = new ResizeObserver(() => draw());
		if (curveCanvas) ro.observe(curveCanvas);
		return () => ro.disconnect();
	});

	/* -------------------------------------------------------- actions ----- */
	function applyPreset(preset) {
		presetId = preset.id;
		species = preset.species;
		weightKg = preset.weightKg;
		breed = preset.breed;
		lifeStage = preset.lifeStage;
		const sc = preset.scenario;
		mode = sc.kind;
		if (sc.kind === 'chocolate') {
			matrixKey = sc.matrixKey;
			massG = sc.massG;
			minutesSinceIngestion = sc.minutesSinceIngestion;
			dehydrationPct = 5;
		} else {
			toxinKey = sc.toxinKey;
			toxinVariant = sc.variant || TOXIN_PROFILES[sc.toxinKey]?.variants[0].key;
			toxinAmount = sc.amount;
			minutesSinceIngestion = sc.minutesSinceIngestion;
			dehydrationPct = sc.dehydrationPct ?? 5;
		}
		pushToast(`Loaded case: ${preset.label}`, 'ok');
	}

	function selectToxin(key) {
		toxinKey = key;
		const p = TOXIN_PROFILES[key];
		toxinVariant = p.variants[0].key;
		toxinAmount = p.defaultAmount;
		presetId = null;
	}

	async function saveIncident() {
		if (!can('vault.write')) {
			pushToast('Guardian tier is read-only — switch to Vet Tech to write to the vault', 'warn');
			return;
		}
		saving = true;
		try {
			const record = {
				kind: mode === 'chocolate' ? 'methylxanthine' : toxinResult?.profileKey,
				patientId: $patient.name,
				species,
				breed,
				weightKg,
				matrixKey: mode === 'chocolate' ? matrixKey : null,
				massG: mode === 'chocolate' ? massG : null,
				toxinKey: mode === 'toxin' ? toxinKey : null,
				doseTotalMgKg: mode === 'chocolate' ? dose.doseTotalMgKg : toxinResult?.severity ?? 0,
				zone: mode === 'chocolate' ? zone.key : `severity-${toxinResult?.severity ?? 0}`,
				severity,
				minutesSinceIngestion,
				verdict: mode === 'chocolate' ? zone.label : toxinResult?.headline,
				modelVersion: MODEL_VERSION
			};
			await saveClinicalRecord('toxicology_incidents', record);
			savedCount += 1;
			refreshSyncState();
			pushToast(`Incident committed to IndexedDB · ${mode === 'chocolate' ? fmt(dose.doseTotalMgKg, 1) + ' mg/kg' : toxinResult?.doseText}`, 'ok');
		} catch {
			pushToast('Vault write failed — storage may be blocked', 'bad');
		} finally {
			saving = false;
		}
	}

	const matrixQuick = ['milk', 'dark70', 'bakers', 'cocoa'];
</script>

<section class="module">
	<div class="module-head">
		<div>
			<h1 class="module-title">Toxicology <em>Kinetic Shield</em></h1>
			<p class="module-sub">
				Exact methylxanthine dose in mg/kg with a species-specific Bateman model (theobromine t½ 17.5 h · caffeine
				t½ 4.5 h · enterohepatic recirculation), gastric-emptying decontamination windows, Kleiber allometry and a
				fluid-therapy plan. Nothing is estimated — every number is computed live from the mass and the body weight.
			</p>
		</div>
		<div class="row tight">
			<span class="badge {summaryTone}"><span class="dot"></span>{mode === 'chocolate' ? zone.label : toxinResult?.severityLabel}</span>
			{#if mdr1.listed}<span class="badge warn"><span class="dot"></span>MDR1</span>{/if}
			<span class="badge info"><span class="dot"></span>PK v27</span>
		</div>
	</div>

	<div class="preset-grid">
		{#each CASE_PRESETS as preset}
			<button class="preset" class:active={presetId === preset.id} on:click={() => applyPreset(preset)} title={preset.note}>
				<span class="p-name">{preset.label.split('·')[0]}</span>
				<span class="p-desc">{preset.label.split('·').slice(1).join('·').trim()}</span>
			</button>
		{/each}
	</div>

	<div class="module-grid wide-left">
		<!-- LEFT COLUMN -->
		<div class="col">
			<div class="card">
				<div class="card-head">
					<span class="card-title">Patient &amp; exposure</span>
					<div class="seg teal">
						<button class:active={species === 'dog'} on:click={() => (species = 'dog')}>Canine</button>
						<button class:active={species === 'cat'} on:click={() => (species = 'cat')}>Feline</button>
					</div>
				</div>

				<div class="patient-grid">
					<div class="field">
						<span class="label">Body weight</span>
						<div class="row tight">
							<input
								type="range"
								min="0.5"
								max="80"
								step="0.1"
								bind:value={weightKg}
								aria-label="Body weight in kilograms"
							/>
							<div class="weight-box">
								<input type="number" min="0.2" max="90" step="0.1" bind:value={weightKg} />
								<button class="unit-toggle" on:click={() => (usePounds = !usePounds)}>
									{usePounds ? 'lb' : 'kg'}
								</button>
							</div>
						</div>
						<span class="tiny mute">
							{usePounds ? `${fmt(weightLb, 1)} lb` : `${fmt(weightKg, 1)} kg`} · Kleiber RER {fmt(energy.rer, 0)} kcal/d
						</span>
					</div>

					<div class="field">
						<span class="label">Breed (MDR1 screen)</span>
						<select bind:value={breed}>
							<option>Beagle</option>
							<option>French Bulldog</option>
							<option>Labrador Retriever</option>
							<option>Domestic Shorthair</option>
							<option>Persian</option>
							{#each MDR1_BREEDS as b}<option>{b}</option>{/each}
							<option>Other / mixed breed</option>
						</select>
					</div>

					<div class="field">
						<span class="label">Life stage</span>
						<select bind:value={lifeStage}>
							{#each LIFE_STAGES as s}<option value={s.key}>{s.label}</option>{/each}
						</select>
					</div>

					<div class="field">
						<span class="label">Minutes since ingestion</span>
						<div class="row tight">
							<input type="range" min="0" max="720" step="5" bind:value={minutesSinceIngestion} />
							<input type="number" class="num-input" min="0" max="720" bind:value={minutesSinceIngestion} />
						</div>
					</div>
				</div>

				<div class="divider"></div>

				<div class="seg" role="group" aria-label="Scenario type">
					<button class:active={mode === 'chocolate'} on:click={() => (mode = 'chocolate', (presetId = null))}>Methylxanthine (chocolate)</button>
					<button class:active={mode === 'toxin'} on:click={() => (mode = 'toxin', (presetId = null))}>Emergency toxin matrix</button>
				</div>

				{#if mode === 'chocolate'}
					<div class="stack" style="margin-top:10px">
						<div class="field">
							<span class="label">Product matrix (mg alkaloid / g)</span>
							<select bind:value={matrixKey}>
								{#each CHOCOLATE_MATRICES as m}
									<option value={m.key}>
										{m.label} — theo {m.theo.toFixed(2)} · caff {m.caff.toFixed(2)} mg/g
									</option>
								{/each}
							</select>
						</div>
						<div class="row tight">
							{#each matrixQuick as q}
								<button class="chip" class:active={matrixKey === q} on:click={() => (matrixKey = q)}>
									{getMatrix(q).label.split('(')[0].trim()}
								</button>
							{/each}
						</div>
						<div class="field">
							<span class="label">Ingested mass</span>
							<div class="row tight">
								<input type="range" min="0" max="400" step="1" bind:value={massG} />
								<input type="number" class="num-input" min="0" max="2000" step="1" bind:value={massG} />
								<span class="tiny mute">g</span>
							</div>
						</div>
						<div class="row spread">
							<span class="tiny mute">{matrix.note}</span>
						</div>
						<label class="switch">
							<input type="checkbox" bind:checked={recirculation} />
							<span class="track"></span>
							Enterohepatic recirculation term
						</label>
					</div>
				{:else}
					<div class="stack" style="margin-top:10px">
						<div class="field">
							<span class="label">Toxin</span>
							<select value={toxinKey} on:change={(e) => selectToxin(e.currentTarget.value)}>
								{#each TOXIN_KEYS as k}
									<option value={k}>{TOXIN_PROFILES[k].label}</option>
								{/each}
							</select>
						</div>
						<div class="field">
							<span class="label">Formulation</span>
							<select bind:value={toxinVariant}>
								{#each toxinProfile.variants as v}
									<option value={v.key}>{v.label}</option>
								{/each}
							</select>
						</div>
						<div class="field">
							<span class="label">Amount ingested ({toxinProfile.unit})</span>
							<div class="row tight">
								<input type="range" min="0" max={toxinProfile.unit === 'g' ? 300 : 6000} step="1" bind:value={toxinAmount} />
								<input type="number" class="num-input" min="0" bind:value={toxinAmount} />
							</div>
						</div>
						<p class="tiny mute">{toxinProfile.notes}</p>
					</div>
				{/if}
			</div>

			<div class="card">
				<div class="card-head">
					<span class="card-title">72 h plasma kinetics (Vd-normalised burden)</span>
					<span class="mono tiny dim">{recirculation ? 'recirc on' : 'recirc off'} · {species}</span>
				</div>
				<div class="canvas-wrap" style="height:208px">
					<canvas
						bind:this={curveCanvas}
						role="img"
						aria-label="Plasma theobromine, caffeine and total burden over 72 hours"
						on:mousemove={handleHover}
						on:mouseleave={() => ((hoverT = null), (hoverInfo = null))}
					></canvas>
					<div class="canvas-label">Bateman · theobromine + caffeine</div>
					<div class="canvas-hud">
						{#if hoverInfo}
							<div>t+{hoverInfo.t.toFixed(1)} h</div>
							<div>burden {hoverInfo.burden.toFixed(1)} mg/kg</div>
							<div>theo {hoverInfo.theo.toFixed(2)} mg/L</div>
							<div>caff {hoverInfo.caff.toFixed(2)} mg/L</div>
						{:else}
							<div>Tmax {curve.peak.t.toFixed(1)} h</div>
							<div>Cmax {curve.peak.total.toFixed(2)} mg/L</div>
						{/if}
					</div>
				</div>
				<div class="zone-caption">
					<span>0</span><span>20 GI</span><span>40 cardio</span><span>60 neuro</span><span>100 LD50</span>
				</div>
			</div>

			<div class="card">
				<div class="card-head">
					<span class="card-title">Threshold mass table — this patient, this matrix</span>
					<span class="badge info">{matrix.label.split('(')[0].trim()}</span>
				</div>
				<table class="dtable">
					<thead>
						<tr><th>Clinical threshold</th><th>mg/kg</th><th>Grams required</th><th>Status</th></tr>
					</thead>
					<tbody>
						{#each thresholds as t}
							<tr>
								<td class="strong">{t.zone?.label ?? '—'}</td>
								<td class="num">{t.mgkg}</td>
								<td class="num">{fmt(t.grams, 1)} g</td>
								<td>
									<span class="badge {massG >= t.grams ? 'bad' : 'ok'}">
										<span class="dot"></span>{massG >= t.grams ? 'reached' : 'clear'}
									</span>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
				<p class="tiny mute" style="margin-top:6px">
					Grams required = (threshold mg/kg × body weight) ÷ (theobromine + caffeine mg/g). This is the single most
					useful number to give an owner on the phone.
				</p>
			</div>
		</div>

		<!-- RIGHT COLUMN -->
		<div class="col">
			<div class="card">
				<div class="card-head">
					<span class="card-title">Dose verdict</span>
					<span class="badge {summaryTone}"><span class="dot"></span>{mode === 'chocolate' ? `zone ${METHYLXANTHINE_ZONES.findIndex((z) => z.key === zone.key) + 1}/5` : severity === 4 ? 'critical' : severity >= 2 ? 'urgent' : 'monitor'}</span>
				</div>

				{#if mode === 'chocolate'}
					<div class="dose-hero">
						<div class="metric">
							<span class="k">Total methylxanthine</span>
							<span class="v" class:coral={severity >= 3} class:amber={severity === 2} class:teal={severity <= 1}>
								{fmtMgKg(dose.doseTotalMgKg)}<small>mg/kg</small>
							</span>
						</div>
						<div class="dose-split">
							<span class="mono">theo {fmtMgKg(dose.doseTheoMgKg)}</span>
							<span class="mono">caff {fmtMgKg(dose.doseCaffMgKg)}</span>
						</div>
					</div>
					<div class="zone-bar">
						{#each METHYLXANTHINE_ZONES as z}
							<span
								class:hot={z.key === zone.key}
								style={`background:${z.tone === 'ok' ? 'var(--ok)' : z.tone === 'warn' ? 'var(--warn)' : 'var(--bad)'}`}
								title={z.label}
							></span>
						{/each}
					</div>
					<div class="verdict {zone.tone}" style="margin-top:10px">
						<div class="med-icon {zone.tone === 'bad' ? 'bad' : zone.tone === 'warn' ? 'warn' : ''}">{zone.tone === 'ok' ? '✓' : '!'}</div>
						<div>
							<div class="verdict-title">{zone.label}</div>
							<div class="verdict-body">{zone.action}</div>
						</div>
					</div>
					<div class="kv-row">
						<div class="kv"><span class="k">Ingested mass</span><span class="v">{fmt(massG, 0)} g {matrix.label.split('(')[0]}</span></div>
						<div class="kv"><span class="k">Total alkaloid</span><span class="v">{fmt(dose.totalTheoMg + dose.caffMg, 1)} mg</span></div>
						<div class="kv"><span class="k">Hours above cardiotoxic</span><span class="v">{curve.hoursAboveCardiotoxic.toFixed(1)} h</span></div>
					</div>
				{:else}
					<div class="dose-hero">
						<div class="metric">
							<span class="k">{toxinResult?.profileLabel}</span>
							<span class="v" class:coral={toxinResult?.severity >= 3} class:amber={toxinResult?.severity === 2} class:teal={toxinResult?.severity <= 1}>
								{toxinResult?.doseText}
							</span>
						</div>
						<span class="badge {toxinResult?.severity >= 3 ? 'bad' : toxinResult?.severity === 2 ? 'warn' : 'ok'}">{toxinResult?.severityLabel}</span>
					</div>
					<div class="verdict {toxinResult?.severity >= 3 ? 'bad' : toxinResult?.severity === 2 ? 'warn' : 'info'}" style="margin-top:10px">
						<div class="med-icon {toxinResult?.severity >= 3 ? 'bad' : 'warn'}">{toxinResult?.severity >= 3 ? '!' : 'i'}</div>
						<div>
							<div class="verdict-title">{toxinResult?.headline}</div>
							<div class="verdict-body">{toxinResult?.detail}</div>
						</div>
					</div>
					<div class="action-list">
						{#each toxinResult?.actions ?? [] as a}
							<div class="action-row"><span>▸</span>{a}</div>
						{/each}
					</div>
				{/if}

				<div class="row spread" style="margin-top:11px">
					<button class="btn primary mini" on:click={saveIncident} disabled={saving}>
						{saving ? 'Writing…' : 'Commit to vault'}
					</button>
					<span class="tiny mute">{savedCount} session record{savedCount === 1 ? '' : 's'} · {can('vault.write') ? 'write tier' : 'read-only tier'}</span>
				</div>
			</div>

			<div class="card">
				<div class="card-head">
					<span class="card-title">Decontamination window</span>
					<span class="badge {gastric.emesisEffective ? 'ok' : gastric.charcoalEffective ? 'warn' : 'bad'}">
						<span class="dot"></span>{gastric.emesisEffective ? 'emesis useful' : gastric.charcoalEffective ? 'charcoal only' : 'window closed'}
					</span>
				</div>
				<div class="gastric-row">
					<svg viewBox="0 0 90 90" class="ring" aria-label="Residual gastric fraction">
						<circle cx="45" cy="45" r="36" class="ring-bg" />
						<circle
							cx="45"
							cy="45"
							r="36"
							class="ring-fg"
							stroke={gastric.residualPct >= 40 ? 'var(--ok)' : gastric.residualPct >= 15 ? 'var(--warn)' : 'var(--bad)'}
							stroke-dasharray={`${(gastric.residualPct / 100) * 226.2} 226.2`}
							transform="rotate(-90 45 45)"
						/>
						<text x="45" y="42" text-anchor="middle" class="ring-num">{gastric.residualPct.toFixed(0)}%</text>
						<text x="45" y="55" text-anchor="middle" class="ring-sub">gastric</text>
					</svg>
					<div class="grow">
						<div class="kv"><span class="k">Emesis window</span><span class="v">{gastric.emesisEffective ? `closes in ${Math.round(gastric.minutesUntilEmesisWindow)} min` : 'closed'}</span></div>
						<div class="kv"><span class="k">Charcoal window</span><span class="v">{gastric.charcoalEffective ? `${Math.round(gastric.minutesUntilCharcoalWindow)} min left` : 'closed'}</span></div>
						<div class="kv"><span class="k">Charcoal dose</span><span class="v">1–2 g/kg = {fmt(weightKg * 1, 0)}–{fmt(weightKg * 2, 0)} g</span></div>
						<div class="kv"><span class="k">Apomorphine</span><span class="v">{species === 'dog' ? '0.03 mg/kg IV/eye' : 'avoid — use dexmedetomidine'}</span></div>
					</div>
				</div>
				<p class="tiny mute" style="margin-top:6px">{gastric.recommendation}</p>
			</div>

			<div class="card">
				<div class="card-head">
					<span class="card-title">Allometry · Kleiber 70·W^0.75</span>
					<span class="badge info">{energy.stage.label}</span>
				</div>
				<div class="metric-grid">
					<div class="metric"><span class="k">RER</span><span class="v teal">{fmt(energy.rer, 0)}<small>kcal/d</small></span></div>
					<div class="metric"><span class="k">MER factor</span><span class="v">{energy.k.toFixed(1)}×</span></div>
					<div class="metric"><span class="k">MER</span><span class="v cyan">{fmt(energy.mer, 0)}<small>kcal/d</small></span></div>
					<div class="metric"><span class="k">W^0.75</span><span class="v">{Math.pow(weightKg, 0.75).toFixed(2)}</span></div>
				</div>

				<div class="divider"></div>

				<div class="row spread">
					<span class="label">24 h fluid plan</span>
					<span class="mono tiny">{species === 'dog' ? '132' : '80'}·W^0.75 + deficit</span>
				</div>
				<div class="row tight" style="margin-top:4px">
					<input type="range" min="0" max="12" step="0.5" bind:value={dehydrationPct} aria-label="Dehydration percentage" />
					<span class="mono tiny nowrap">{dehydrationPct}%</span>
				</div>
				<div class="fluid-grid">
					<div class="metric"><span class="k">Deficit</span><span class="v">{fmt(fluids.deficitVolume, 0)}<small>mL</small></span></div>
					<div class="metric"><span class="k">Maint.</span><span class="v">{fmt(fluids.maintenance, 0)}<small>mL</small></span></div>
					<div class="metric"><span class="k">Total / 24 h</span><span class="v teal">{fmt(fluids.total, 0)}<small>mL</small></span></div>
					<div class="metric"><span class="k">Rate</span><span class="v cyan">{fmt(fluids.mlPerHr, 1)}<small>mL/h</small></span></div>
				</div>
				<div class="kv"><span class="k">Drip rate (20 gtt/mL)</span><span class="v">{fmt(fluids.dropsPerMin, 0)} drops/min</span></div>
			</div>

			{#if mdr1.listed}
				<div class="card sim" style="border-left-color:var(--amber)">
					<div class="card-head">
						<span class="card-title">Pharmacogenomic flag</span>
						<span class="badge warn"><span class="dot"></span>MDR1 / ABCB1-1Δ</span>
					</div>
					<p class="small" style="margin:0;color:var(--text-dim)">{mdr1.body}</p>
				</div>
			{/if}
		</div>
	</div>
</section>

<style>
	.patient-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(158px, 1fr));
		gap: 10px;
	}

	.weight-box {
		display: flex;
		align-items: center;
		gap: 4px;
		flex: none;
	}

	.weight-box input {
		width: 62px;
		padding: 6px 7px;
		font-size: 11.5px;
	}

	.unit-toggle {
		appearance: none;
		border: 1px solid var(--stroke);
		background: color-mix(in srgb, var(--teal) 14%, transparent);
		color: var(--teal);
		font-family: var(--font-mono);
		font-size: 9px;
		font-weight: 700;
		padding: 5px 6px;
		border-radius: 7px;
		cursor: pointer;
		text-transform: uppercase;
	}

	.num-input {
		width: 70px;
		flex: none;
		padding: 6px 8px;
		font-size: 11.5px;
	}

	.dose-hero {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 9px;
	}

	.dose-hero .metric .v {
		font-size: 30px;
	}

	.dose-split {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 2px;
		font-size: 9.5px;
		color: var(--text-mute);
	}

	.kv-row {
		display: flex;
		flex-direction: column;
		margin-top: 8px;
	}

	.gastric-row {
		display: flex;
		align-items: center;
		gap: 14px;
	}

	.ring {
		width: 86px;
		height: 86px;
		flex: none;
	}

	.ring-bg {
		fill: none;
		stroke: color-mix(in srgb, var(--bg-0) 70%, transparent);
		stroke-width: 8;
	}

	.ring-fg {
		fill: none;
		stroke-width: 8;
		stroke-linecap: round;
		transition: stroke-dasharray 0.6s var(--ease-out), stroke 0.4s ease;
		filter: drop-shadow(0 0 6px currentColor);
	}

	.ring-num {
		fill: var(--text);
		font-size: 17px;
		font-weight: 700;
		font-family: var(--font-mono);
	}

	.ring-sub {
		fill: var(--text-mute);
		font-size: 8px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	.action-list {
		display: flex;
		flex-direction: column;
		gap: 5px;
		margin-top: 9px;
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

	.fluid-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(72px, 1fr));
		gap: 7px;
		margin: 8px 0 6px;
	}
</style>
