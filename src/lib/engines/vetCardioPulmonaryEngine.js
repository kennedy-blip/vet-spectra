/**
 * VET-SPECTRA · vetCardioPulmonaryEngine.js
 * ---------------------------------------------------------------------------
 * Canine / feline cardiac auscultation + ACVIM cardiopulmonary monitoring.
 *
 *   • PCG synthesis (normal, MMVD systolic murmur, HCM gallop, PDA continuous)
 *   • Zero-phase Butterworth PCG filtering, Shannon-energy S1/S2 segmentation
 *   • SMER — Systolic Murmur Energy Ratio, mapped to the Levine I–VI scale,
 *     lifted to grade VI when the seismocardiogram detects a palpable thrill
 *     (RMS > 38 milli-g).
 *   • SCG (seismocardiogram) RMS helper for the phone accelerometer.
 *   • RSA / HRV: RMSSD, SDNN, CV_RR, pNN50 with a < 4 % CV_RR + HR > 130 bpm
 *     decompensation flag.
 *   • ACVIM sleeping respiratory rate (SRR) consensus analysis with rolling
 *     median, 14-day baseline, and staged CHF alerts (≥ 30 br/min).
 * ---------------------------------------------------------------------------
 */

import {
	bandpass,
	clamp,
	dbfs,
	filtfilt,
	medianSmooth,
	mulberry32,
	normalize,
	pickPeaks,
	rms,
	shannonEnergyEnvelope,
	mean,
	stdev
} from './dspKernels.js';

export const MODEL_VERSION = 'vet-spectra/cardio-27.0.0';
export const AUSCULTATION_SR = 8000;

/* =========================================================================
 * 1. LEVINE GRADING
 * ========================================================================= */
export const LEVINE_GRADES = [
	{ grade: 'I', roman: 'I', smerMin: 0, smerMax: 4, label: 'Grade I / VI', desc: 'Barely audible, only in a quiet room after several minutes.' },
	{ grade: 'II', roman: 'II', smerMin: 4, smerMax: 8, label: 'Grade II / VI', desc: 'Soft but immediately audible with the stethoscope.' },
	{ grade: 'III', roman: 'III', smerMin: 8, smerMax: 14, label: 'Grade III / VI', desc: 'Moderate intensity, similar to S1/S2.' },
	{ grade: 'IV', roman: 'IV', smerMin: 14, smerMax: 22, label: 'Grade IV / VI', desc: 'Loud, radiating widely, no palpable thrill.' },
	{ grade: 'V', roman: 'V', smerMin: 22, smerMax: 32, label: 'Grade V / VI', desc: 'Very loud; thrill palpable; heard with the stethoscope barely on the chest.' },
	{ grade: 'VI', roman: 'VI', smerMin: 32, smerMax: Infinity, label: 'Grade VI / VI', desc: 'Heard with the stethoscope lifted off the chest wall — thrill present.' }
];

export const THRILL_RMS_THRESHOLD_MG = 38;

export function gradeFromSmer(smer, scgRmsMg = 0) {
	let idx = LEVINE_GRADES.findIndex((g) => smer >= g.smerMin && smer < g.smerMax);
	if (idx < 0) idx = LEVINE_GRADES.length - 1;
	const thrill = scgRmsMg > THRILL_RMS_THRESHOLD_MG;
	// A palpable thrill establishes at least grade V; grade VI additionally needs
	// the murmur energy to clear the 32 % SMER cut-off.
	if (thrill) idx = Math.max(idx, 4);
	return {
		...LEVINE_GRADES[idx],
		thrill,
		scgRmsMg,
		index: idx + 1
	};
}

/* =========================================================================
 * 2. PCG PRESETS
 * ========================================================================= */
export const PCG_PRESETS = [
	{
		key: 'normal',
		label: 'Normal Sinus Rhythm',
		short: 'Normal',
		hrBpm: 104,
		species: 'dog',
		expectedGrade: 'I',
		smerTarget: 2.0,
		pathology: null,
		note: 'S1/S2 crisp, no murmur. Physiologic sinus arrhythmia is normal in dogs.'
	},
	{
		key: 'mmvd',
		label: 'MMVD · Systolic Murmur (Grade IV)',
		short: 'MMVD Murmur',
		hrBpm: 148,
		species: 'dog',
		expectedGrade: 'IV',
		smerTarget: 17.5,
		pathology: 'Myxomatous mitral valve degeneration — left apical systolic murmur radiating to the axilla.',
		note: 'ACVIM stage B2/C candidate. Consider pimobendan if cardiomegaly + LA enlargement.'
	},
	{
		key: 'hcm',
		label: 'HCM · Gallop + Soft Systolic',
		short: 'HCM Gallop',
		hrBpm: 186,
		species: 'cat',
		expectedGrade: 'II',
		smerTarget: 6.5,
		pathology: 'Hypertrophic cardiomyopathy with S4 gallop and dynamic LVOT obstruction.',
		note: 'Feline HCM often presents with a gallop rather than a loud murmur. Measure NT-proBNP + echo.'
	},
	{
		key: 'pda',
		label: 'PDA · Continuous Machinery Murmur',
		short: 'PDA Continuous',
		hrBpm: 132,
		species: 'dog',
		expectedGrade: 'V',
		smerTarget: 27,
		pathology: 'Patent ductus arteriosus — continuous machinery murmur peaking at S2, bounding pulses.',
		note: 'Closure (device or ligation) is curative if performed before irreversible LV remodelling.'
	}
];

export function getPcgPreset(key) {
	return PCG_PRESETS.find((p) => p.key === key) || PCG_PRESETS[0];
}

/* =========================================================================
 * 3. PCG SYNTHESIS
 * ========================================================================= */
function addBurst(out, sr, startS, durationS, { f1, f2, amp, decay, seed, thump = 0 }) {
	const rand = mulberry32(seed);
	const start = Math.floor(startS * sr);
	const len = Math.floor(durationS * sr);
	const noise = new Float32Array(len);
	for (let i = 0; i < len; i++) noise[i] = (rand() - 0.5) * 2;
	const filtered = bandpass(noise, sr, f1, f2, 2);
	for (let i = 0; i < len; i++) {
		const idx = start + i;
		if (idx < 0 || idx >= out.length) continue;
		const dt = i / sr;
		const env = Math.exp(-decay * dt);
		const thumpWave = thump ? Math.sin(2 * Math.PI * thump * dt) * Math.exp(-26 * dt) : 0;
		out[idx] += (filtered[i] * 1.2 + thumpWave * 0.8) * env * amp;
	}
}

/** Continuous band-limited noise with a shaped envelope (murmurs). */
function addEnvelopeNoise(out, sr, startS, durationS, { f1, f2, amp, shape = 'diamond', seed }) {
	const rand = mulberry32(seed);
	const start = Math.floor(startS * sr);
	const len = Math.floor(durationS * sr);
	const noise = new Float32Array(len);
	for (let i = 0; i < len; i++) noise[i] = (rand() - 0.5) * 2;
	const filtered = bandpass(noise, sr, f1, f2, 2);
	for (let i = 0; i < len; i++) {
		const idx = start + i;
		if (idx < 0 || idx >= out.length) continue;
		const x = i / Math.max(1, len - 1);
		let env = 0;
		if (shape === 'diamond') env = Math.pow(Math.sin(Math.PI * x), 1.35);
		else if (shape === 'plateau') env = Math.pow(Math.sin(Math.PI * x), 0.35);
		else if (shape === 'decay') env = Math.exp(-2.6 * x);
		else env = Math.sin(Math.PI * x);
		out[idx] += filtered[i] * env * amp;
	}
}

/**
 * Synthesise a phonocardiogram as mono Float32 PCM.
 * @param {string} key
 * @param {{seconds?:number, sampleRate?:number, hrBpm?:number, seed?:number}} opts
 */
export function synthesizePCG(key, opts = {}) {
	const preset = getPcgPreset(key);
	const sr = opts.sampleRate || AUSCULTATION_SR;
	const seconds = opts.seconds || 4.0;
	const hr = opts.hrBpm || preset.hrBpm;
	const cycle = 60 / hr;
	const n = Math.floor(seconds * sr);
	const out = new Float32Array(n);
	const cycles = Math.ceil(seconds / cycle);
	let seed = opts.seed ?? 0x4c2f7a;

	for (let c = 0; c < cycles; c++) {
		const t0 = c * cycle;
		const systole = cycle * 0.36;
		const diastole = cycle - systole;

		// S1 — mitral/tricuspid closure, low frequency, 90 ms
		addBurst(out, sr, t0, 0.11, { f1: 28, f2: 150, amp: 0.75, decay: 42, seed: seed++, thump: 48 });
		// S2 — semilunar closure, higher and shorter
		addBurst(out, sr, t0 + systole, 0.075, { f1: 45, f2: 220, amp: 0.55, decay: 55, seed: seed++, thump: 68 });

		if (key === 'mmvd') {
			addEnvelopeNoise(out, sr, t0 + 0.045, systole - 0.09, { f1: 140, f2: 620, amp: 0.11, shape: 'diamond', seed: seed++ });
		} else if (key === 'hcm') {
			addEnvelopeNoise(out, sr, t0 + 0.03, systole - 0.08, { f1: 150, f2: 500, amp: 0.24, shape: 'diamond', seed: seed++ });
			// S4 gallop — atrial kick just before S1
			addBurst(out, sr, t0 + cycle - 0.09, 0.08, { f1: 22, f2: 90, amp: 0.36, decay: 48, seed: seed++, thump: 34 });
		} else if (key === 'pda') {
			// continuous machinery murmur peaking at S2
			addEnvelopeNoise(out, sr, t0 + 0.02, cycle - 0.05, { f1: 130, f2: 900, amp: 0.13, shape: 'plateau', seed: seed++ });
		}

		if (key !== 'normal') {
			// faint respiratory / contact noise so the analyser has realistic SNR
			addEnvelopeNoise(out, sr, t0, cycle, { f1: 60, f2: 1800, amp: 0.012, shape: 'plateau', seed: seed++ });
		}
	}
	// 50 Hz mains hum + sensor noise
	const rand = mulberry32(seed);
	for (let i = 0; i < n; i++) {
		const t = i / sr;
		out[i] += Math.sin(2 * Math.PI * 50 * t) * 0.0035 + (rand() - 0.5) * 0.006;
	}
	return normalize(out, 0.88);
}

/* =========================================================================
 * 4. S1/S2 SEGMENTATION + SMER
 * ========================================================================= */
/**
 * Segment heart sounds from a PCG signal.
 * @returns {{peaks:number[], labels:string[], hrBpm:number, cycleS:number,
 *            systoleS:number, diastoleS:number, envelope:Float32Array,
 *            filtered:Float32Array}}
 */
export function segmentHeartSounds(samples, sr = AUSCULTATION_SR) {
	const filtered = filtfilt(highpassSafe(samples, sr, 22), sr, 24, 420, 2);
	const env = medianSmooth(shannonEnergyEnvelope(filtered, 48), 7);
	const peaks = pickPeaks(env, { minHeightRatio: 0.24, minGap: Math.floor(sr * 0.09) });
	if (peaks.length < 4) {
		return { peaks, labels: peaks.map(() => 'S1'), hrBpm: 0, cycleS: 0, systoleS: 0, diastoleS: 0, envelope: env, filtered, confidence: 0 };
	}

	// Alternating interval analysis to decide which alternate is systole.
	const even = [];
	const odd = [];
	for (let i = 1; i < peaks.length; i++) {
		const d = (peaks[i] - peaks[i - 1]) / sr;
		if (i % 2 === 1) odd.push(d);
		else even.push(d);
	}
	const meanOdd = mean(odd);
	const meanEven = mean(even);
	const oddIsSystole = meanOdd <= meanEven;
	const labels = peaks.map((_, i) => (i % 2 === 1 ? (oddIsSystole ? 'S2' : 'S1') : oddIsSystole ? 'S1' : 'S2'));
	const systoleS = oddIsSystole ? meanOdd : meanEven;
	const diastoleS = oddIsSystole ? meanEven : meanOdd;
	const cycleS = systoleS + diastoleS;
	const hrBpm = cycleS > 0 ? 60 / cycleS : 0;

	return { peaks, labels, hrBpm, cycleS, systoleS, diastoleS, envelope: env, filtered, confidence: clamp(peaks.length / (sampleSeconds(env, sr) * 2), 0, 1) };
}

function highpassSafe(sig, sr, fc) {
	return bandpass(sig, sr, fc, Math.min(3800, sr / 2 - 200), 2);
}

function sampleSeconds(arr, sr) {
	return arr.length / sr;
}

/**
 * Systolic Murmur Energy Ratio.
 *   SMER = 100 · E_murmur,systole / (E_murmur,systole + E_S1 + E_S2)
 */
export function systolicMurmurEnergyRatio(samples, sr = AUSCULTATION_SR, segmentation = null) {
	const seg = segmentation || segmentHeartSounds(samples, sr);
	if (!seg.peaks.length) return { smer: 0, ...seg, murmurBandEnergy: 0, valveEnergy: 0 };
	// Both terms are measured in the same 130–700 Hz band so the ratio compares
	// like with like: broadband S1/S2 thump energy (30–90 Hz) must not swamp a
	// murmur that lives entirely above 130 Hz.
	const band = bandpass(samples, sr, 130, 700, 3);
	let murmurEnergy = 0;
	let valveEnergy = 0;
	const win = Math.floor(sr * 0.032);

	for (let i = 0; i < seg.peaks.length; i++) {
		if (seg.labels[i] !== 'S1') continue;
		const s1 = seg.peaks[i];
		const s2 = seg.peaks[i + 1];
		if (s2 == null) continue;
		// Valve-closure energy: S1 and its paired S2 only — gallops and diastolic
		// extras are deliberately excluded so they cannot dilute the ratio.
		for (let j = Math.max(0, s1 - win); j < Math.min(band.length, s1 + win); j++) valveEnergy += band[j] * band[j];
		for (let j = Math.max(0, s2 - win); j < Math.min(band.length, s2 + win); j++) valveEnergy += band[j] * band[j];
		// Systolic window: clear of both closures.
		const from = s1 + Math.floor(sr * 0.055);
		const to = s2 - Math.floor(sr * 0.03);
		for (let j = Math.max(0, from); j < Math.min(band.length, to); j++) murmurEnergy += band[j] * band[j];
	}
	const smer = (murmurEnergy / Math.max(1e-12, murmurEnergy + valveEnergy)) * 100;
	return { smer, murmurBandEnergy: murmurEnergy, valveEnergy, ...seg };
}

/**
 * Full PCG analysis.
 * @param {Float32Array} samples
 * @param {{sampleRate?:number, scgRmsMg?:number, presetKey?:string}} opts
 */
export function analyzePCG(samples, opts = {}) {
	const sr = opts.sampleRate || AUSCULTATION_SR;
	const seg = segmentHeartSounds(samples, sr);
	const { smer } = systolicMurmurEnergyRatio(samples, sr, seg);
	const scgRmsMg = opts.scgRmsMg ?? 0;
	const grade = gradeFromSmer(smer, scgRmsMg);
	const preset = opts.presetKey ? getPcgPreset(opts.presetKey) : null;
	const expected = preset ? LEVINE_GRADES.find((g) => g.roman === preset.expectedGrade) : null;

	return {
		smer,
		hrBpm: seg.hrBpm,
		cycleS: seg.cycleS,
		systoleS: seg.systoleS,
		diastoleS: seg.diastoleS,
		peaks: seg.peaks,
		labels: seg.labels,
		envelope: seg.envelope,
		filtered: seg.filtered,
		grade,
		scgRmsMg,
		thrill: grade.thrill,
		expectedGrade: preset?.expectedGrade ?? null,
		matchesPreset: expected ? Math.abs(smer - preset.smerTarget) < 6 : null,
		rmsDb: dbfs(rms(samples)),
		note: grade.index >= 3
			? 'Murmur ≥ III/VI warrants echocardiography, blood pressure and NT-proBNP/proBNP for ACVIM staging.'
			: 'Low-grade or no murmur — re-auscultate in a quiet room; repeat if clinical signs progress.'
	};
}

/* =========================================================================
 * 5. SEISMOCARDIOGRAM (thrill detection)
 * ========================================================================= */
export function simulateScg({ presetKey = 'normal', seconds = 3, sampleRate = 200, seed = 0x77a1 } = {}) {
	const preset = getPcgPreset(presetKey);
	const n = Math.floor(seconds * sampleRate);
	const out = new Float32Array(n);
	const cycle = 60 / preset.hrBpm;
	const rand = mulberry32(seed);
	// Base amplitude in milli-g — a palpable thrill reads > 38 mG RMS.
	const base = presetKey === 'normal' ? 11 : presetKey === 'hcm' ? 26 : presetKey === 'pda' ? 58 : 44;
	for (let i = 0; i < n; i++) {
		const t = i / sampleRate;
		const phase = (t % cycle) / cycle;
		let v = 0;
		// aortic and mitral components as damped sinusoids
		for (const [centre, amp] of [[0.06, 1.0], [0.42, 0.62]]) {
			const dt = phase - centre;
			if (dt > -0.02 && dt < 0.16) {
				v += Math.sin(2 * Math.PI * 14 * dt) * Math.exp(-26 * Math.max(0, dt)) * amp;
			}
		}
		out[i] = v * base * 0.55 + (rand() - 0.5) * base * 0.16;
	}
	return out;
}

/** RMS of a milli-g calibrated seismocardiogram trace. */
export function scgRmsMilliG(signal) {
	return rms(signal);
}

/** Convert a raw accelerometer trace (in g) to milli-g RMS. */
export function accelerometerRmsMg(samples) {
	const r = rms(samples);
	return Math.abs(r) <= 1 ? r * 1000 : r;
}

/* =========================================================================
 * 6. RSA / HRV
 * ========================================================================= */
export function hrvFromRR(rrMs) {
	const rr = rrMs.filter((v) => v > 150 && v < 4000);
	if (rr.length < 3) {
		return { rmssd: 0, sdnn: 0, cvrr: 0, pnn50: 0, meanHr: 0, meanRR: 0, beats: rr.length, rsaPresent: false };
	}
	let sumSq = 0;
	let nn50 = 0;
	for (let i = 1; i < rr.length; i++) {
		const d = rr[i] - rr[i - 1];
		sumSq += d * d;
		if (Math.abs(d) > 50) nn50++;
	}
	const rmssd = Math.sqrt(sumSq / (rr.length - 1));
	const sdnn = stdev(rr);
	const meanRR = mean(rr);
	const cvrr = (sdnn / meanRR) * 100;
	return {
		rmssd,
		sdnn,
		cvrr,
		pnn50: (nn50 / (rr.length - 1)) * 100,
		meanHr: 60000 / meanRR,
		meanRR,
		beats: rr.length,
		rsaPresent: cvrr >= 4
	};
}

export function decompensationFlag({ cvrr = 0, meanHr = 0 }) {
	const lowVariability = cvrr < 4;
	const tachy = meanHr > 130;
	if (lowVariability && tachy)
		return {
			active: true,
			level: 'critical',
			title: 'Decompensation pattern detected',
			body: `CV_RR ${cvrr.toFixed(1)} % (< 4 %) with HR ${meanHr.toFixed(0)} bpm (> 130). Loss of respiratory sinus arrhythmia plus tachycardia is a recognised congestive-heart-failure decompensation pattern. Escalate to a cardiology review.`
		};
	if (lowVariability)
		return {
			active: true,
			level: 'warn',
			title: 'Reduced heart-rate variability',
			body: `CV_RR ${cvrr.toFixed(1)} % — sinus arrhythmia is blunted. Re-measure at rest; consider thoracic auscultation and SRR logging.`
		};
	return {
		active: false,
		level: 'ok',
		title: 'Physiologic sinus arrhythmia present',
		body: `CV_RR ${cvrr.toFixed(1)} % — healthy respiratory sinus arrhythmia.`
	};
}

export const RR_PRESETS = [
	{ key: 'healthy', label: 'Healthy RSA (dog)', hrBpm: 96, cvTarget: 12.5, rsaAmplitude: 0.16, note: 'Strong respiratory sinus arrhythmia — classic healthy canine rhythm.' },
	{ key: 'chf', label: 'CHF Decompensation', hrBpm: 148, cvTarget: 2.8, rsaAmplitude: 0.025, note: 'Tachycardia with blunted RSA — high sympathetic drive.' },
	{ key: 'feline_stress', label: 'Feline Stress Tachycardia', hrBpm: 214, cvTarget: 5.5, rsaAmplitude: 0.06, note: 'Cats hide arrhythmia; > 200 bpm often reflects clinic stress alone.' }
];

export function synthesizeRRSeries(presetKey = 'healthy', { beats = 40, seed = 0x2b7e } = {}) {
	const preset = RR_PRESETS.find((p) => p.key === presetKey) || RR_PRESETS[0];
	const rand = mulberry32(seed);
	const rr = [];
	const base = 60000 / preset.hrBpm;
	for (let i = 0; i < beats; i++) {
		const resp = Math.sin((2 * Math.PI * i) / 7.2) * preset.rsaAmplitude;
		const noise = (rand() - 0.5) * 0.014;
		rr.push(base * (1 + resp + noise));
	}
	return { preset, rr };
}

/* =========================================================================
 * 7. ACVIM SLEEPING RESPIRATORY RATE
 * ========================================================================= */
export const SRR_THRESHOLD = 30;
export const SRR_CRITICAL = 40;

/**
 * Evaluate an SRR log (array of { date:ISO, bpm:number }).
 * Uses a 7-reading rolling median against a 14-day baseline.
 */
export function evaluateSRR(history = []) {
	const readings = history
		.map((r) => ({ ...r, bpm: Number(r.bpm) }))
		.filter((r) => isFinite(r.bpm) && r.bpm > 0)
		.sort((a, b) => new Date(a.date) - new Date(b.date));

	if (!readings.length) {
		return {
			readings: [],
			latest: 0,
			median7: 0,
			baseline: 0,
			deltaPct: 0,
			status: 'no-data',
			tone: 'ok',
			title: 'No sleeping respiratory rate logged',
			body: 'Count breaths for 30 seconds while the patient is genuinely asleep, ×2, and log it. Three consistent readings establish a baseline.',
			trend: []
		};
	}

	const last7 = readings.slice(-7).map((r) => r.bpm);
	const median7 = medianOf(last7);
	const latest = readings[readings.length - 1].bpm;
	const baselinePool = readings.slice(0, Math.max(3, Math.min(readings.length, 14))).map((r) => r.bpm);
	const baseline = medianOf(baselinePool);
	const deltaPct = baseline > 0 ? ((median7 - baseline) / baseline) * 100 : 0;

	let status = 'normal';
	let tone = 'ok';
	let title = 'SRR within ACVIM normal range';
	let body = `Rolling median ${median7.toFixed(0)} br/min (< 30). Continue twice-weekly home counting.`;

	if (median7 >= SRR_CRITICAL) {
		status = 'critical';
		tone = 'bad';
		title = 'SRR ≥ 40 br/min — urgent review';
		body = `Rolling median ${median7.toFixed(0)} br/min. This is well above the ACVIM 30 br/min threshold and suggests active pulmonary oedema. Contact the cardiology service today — do not adjust diuretics without veterinary supervision.`;
	} else if (median7 >= SRR_THRESHOLD) {
		status = 'alert';
		tone = 'bad';
		title = 'SRR ≥ 30 br/min — ACVIM CHF alert';
		body = `Rolling median ${median7.toFixed(0)} br/min (${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(0)} % vs baseline). Sustained SRR ≥ 30 is the ACVIM consensus threshold for Stage C congestive heart failure — arrange a same-week review.`;
	} else if (deltaPct >= 20) {
		status = 'watch';
		tone = 'warn';
		title = 'Rising trend below threshold';
		body = `Rolling median ${median7.toFixed(0)} br/min is ${deltaPct.toFixed(0)} % above the 14-day baseline. A ≥ 20 % rise can precede overt oedema by 1–2 weeks — increase counting frequency.`;
	} else if (latest >= SRR_THRESHOLD) {
		status = 'watch';
		tone = 'warn';
		title = 'Single elevated reading';
		body = `Latest reading ${latest.toFixed(0)} br/min is above 30 but the rolling median (${median7.toFixed(0)}) is not. Re-count on two more nights; artefacts from dreaming or hot weather are common.`;
	}

	return {
		readings,
		latest,
		median7,
		baseline,
		deltaPct,
		status,
		tone,
		title,
		body,
		trend: readings.map((r) => ({ date: r.date, bpm: r.bpm }))
	};
}

function medianOf(arr) {
	if (!arr.length) return 0;
	const s = Array.from(arr).sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Convert a 30-second breath count to breaths/min. */
export function breathsPerMinuteFromCount(count, seconds = 30) {
	if (!seconds) return 0;
	return (Number(count) / seconds) * 60;
}

/** ACVIM stage suggestion from murmur grade + SRR + LA enlargement flag. */
export function acvimStage({ gradeIndex = 0, srrMedian = 0, laEnlarged = false, cardiomegaly = false, symptomatic = false }) {
	if (srrMedian >= SRR_THRESHOLD || symptomatic)
		return { stage: 'C', label: 'ACVIM Stage C', tone: 'bad', note: 'Congestive heart failure present or historic — diuretic + pimobendan therapy indicated under veterinary direction.' };
	if (gradeIndex >= 3 && (laEnlarged || cardiomegaly))
		return { stage: 'B2', label: 'ACVIM Stage B2', tone: 'warn', note: 'Asymptomatic but remodelled — pimobendan has proven benefit. Echocardiogram required to confirm LA/Ao > 1.6.' };
	if (gradeIndex >= 2)
		return { stage: 'B1', label: 'ACVIM Stage B1', tone: 'info', note: 'Murmur without remodelling — recheck every 6–12 months with echo.' };
	return { stage: 'A', label: 'ACVIM Stage A', tone: 'ok', note: 'At risk breed but no current evidence of disease. Annual auscultation.' };
}
