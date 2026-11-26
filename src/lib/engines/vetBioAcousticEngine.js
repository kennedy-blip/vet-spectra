/**
 * VET-SPECTRA · vetBioAcousticEngine.js
 * ---------------------------------------------------------------------------
 * Canine / feline bio-acoustic airway laboratory.
 *
 *   • Deterministic physical synthesis of seven reference respiratory and
 *     vocal signatures (so the lab is fully demonstrable offline, no assets).
 *   • Feature extraction: autocorrelation f0, spectral centroid, band ratios,
 *     cepstral peak prominence (CPP), harmonic-to-noise ratio, burst rate,
 *     duty factor, inspiratory/expiratory energy split.
 *   • Weighted rule-based classifier with per-species priors.
 *   • BOAS (brachycephalic obstructive airway syndrome) functional grading:
 *     Estertor ∫80–280 Hz, Estridor ∫500–1800 Hz, ASOI obstruction index,
 *     grade 0–III.
 *   • Web Audio playback helper (buffered, cancellable).
 *
 * Mirrored by python_vet/quadruped_gait_acoustic_biometrics.py.
 * ---------------------------------------------------------------------------
 */

import {
	bandpass,
	dbfs,
	envelopeAbs,
	fftInPlace,
	hann,
	medianSmooth,
	mulberry32,
	normalize,
	rms,
	stftFrames
} from './dspKernels.js';

export const SAMPLE_RATE = 24000;
export const MODEL_VERSION = 'vet-spectra/acoustic-27.0.0';

/* =========================================================================
 * 1. CANONICAL SIGNATURE LIBRARY
 * ========================================================================= */
export const ACOUSTIC_SIGNATURES = [
	{
		key: 'purr',
		label: 'Feline Purr (harmonic comb)',
		short: 'Purr',
		species: 'cat',
		icon: '◠',
		ideal: { f0: 26, centroid: 625, hnr: 11, burst: 0.25, duty: 0.8, lowRatio: 0.14, midRatio: 0.68 },
		clinical:
			'26–30 Hz laryngeal fundamental with up to 60 harmonics, duty factor > 0.75 (continuous). Absence of purr during handling is a soft pain indicator; purr is NOT proof of wellbeing.'
	},
	{
		key: 'kennel_cough',
		label: 'Kennel Cough (paroxysmal honk)',
		short: 'Kennel Cough',
		species: 'dog',
		icon: '◉',
		ideal: { f0: 330, centroid: 665, hnr: 10, burst: 3.3, duty: 0.33, lowRatio: 0.08, midRatio: 0.72 },
		clinical:
			'Paroxysmal dry honking bursts at 2–6 per second, often ending in a retch. Bordetella bronchiseptica / CPIV. Highly contagious — isolate in the kennel.'
	},
	{
		key: 'reverse_sneeze',
		label: 'Reverse Sneeze (inspiratory snort)',
		short: 'Reverse Sneeze',
		species: 'dog',
		icon: '⇅',
		ideal: { f0: 430, centroid: 490, hnr: 6, burst: 5.0, duty: 0.46, lowRatio: 0.07, midRatio: 0.93 },
		clinical:
			'Rapid forceful inspiratory snorts at 5–12 per second, 200–700 Hz, self-limiting over 10–30 s. Benign in most small breeds; rule out nasal foreign body if unilateral.'
	},
	{
		key: 'boas_stertor',
		label: 'BOAS Stertor (nasopharyngeal)',
		short: 'BOAS Stertor',
		species: 'dog',
		icon: '▂',
		ideal: { f0: 1670, centroid: 186, hnr: 12, burst: 0.95, duty: 0.65, lowRatio: 0.98, midRatio: 0.02 },
		clinical:
			'Low-frequency 80–280 Hz snoring turbulence from soft-palate elongation and stenotic nares. Worsens with exercise and heat — the classic brachycephalic presentation.'
	},
	{
		key: 'boas_stridor',
		label: 'BOAS Stridor (laryngeal)',
		short: 'BOAS Stridor',
		species: 'dog',
		icon: '▃',
		ideal: { f0: 1016, centroid: 1524, hnr: -10, burst: 0.95, duty: 0.69, lowRatio: 0.02, midRatio: 0.02 },
		clinical:
			'High-frequency 500–1800 Hz inspiratory stridor — laryngeal collapse or everted laryngeal saccules. A stridor-dominant BOAS patient needs airway surgery, not just weight loss.'
	},
	{
		key: 'feline_wheeze',
		label: 'Feline Asthma Wheeze',
		short: 'Asthma Wheeze',
		species: 'cat',
		icon: '∿',
		ideal: { f0: 798, centroid: 1172, hnr: -10.5, burst: 1.2, duty: 0.64, lowRatio: 0.02, midRatio: 0.82 },
		clinical:
			'Expiratory polyphonic wheeze 600–1800 Hz with a tonal core and high harmonicity. Distinguish from cardiac wheeze (usually left-sided crackles plus murmur).'
	},
	{
		key: 'goose_honk',
		label: 'Off-target Goose Honk (recall control)',
		short: 'Goose Honk',
		species: 'any',
		icon: '⌁',
		ideal: { f0: 501, centroid: 1932, hnr: -2.4, burst: 0.7, duty: 0.16, lowRatio: 0.04, midRatio: 0.54 },
		clinical:
			'Ambient calibration signal that must NOT raise an airway alarm — used to demonstrate false-positive rejection at kennels and outdoor triage tents.'
	}
];

export function getSignature(key) {
	return ACOUSTIC_SIGNATURES.find((s) => s.key === key) || ACOUSTIC_SIGNATURES[0];
}

/* =========================================================================
 * 2. BAND ENERGY HELPER
 * ========================================================================= */
export const BANDS = [
	{ key: 'sub', label: 'Sub-bass', lo: 18, hi: 80 },
	{ key: 'low', label: 'Low (stertor)', lo: 80, hi: 280 },
	{ key: 'mid', label: 'Mid (voice)', lo: 280, hi: 900 },
	{ key: 'high', label: 'High (stridor)', lo: 900, hi: 2400 },
	{ key: 'top', label: 'Top (wheeze)', lo: 2400, hi: 6000 }
];

export function bandEnergies(samples, sr, fftSize = 8192) {
	const re = new Float32Array(fftSize);
	const im = new Float32Array(fftSize);
	const n = Math.min(fftSize, samples.length);
	for (let i = 0; i < n; i++) re[i] = samples[i] * hann(i, fftSize);
	fftInPlace(re, im);
	const half = fftSize >> 1;
	const binHz = sr / fftSize;
	const sums = {};
	for (const b of BANDS) sums[b.key] = 0;
	let total = 0;
	for (let i = 1; i < half; i++) {
		const f = i * binHz;
		const p = re[i] * re[i] + im[i] * im[i];
		total += p;
		for (const b of BANDS) if (f >= b.lo && f < b.hi) sums[b.key] += p;
	}
	const out = { total };
	for (const b of BANDS) out[b.key] = sums[b.key];
	out.stertorEnergy = sums.low + sums.sub * 0.6;
	out.stridorEnergy = sums.high + sums.top * 0.35;
	out.stertorDb = 10 * Math.log10(Math.max(1e-12, out.stertorEnergy));
	out.stridorDb = 10 * Math.log10(Math.max(1e-12, out.stridorEnergy));
	out.totalDb = 10 * Math.log10(Math.max(1e-12, total));
	return out;
}

/* =========================================================================
 * 3. PITCH, HARMONICITY AND CEPSTRAL ANALYSIS
 * ========================================================================= */
/** Autocorrelation pitch tracker with parabolic interpolation. */
export function estimateF0(samples, sr, minHz = 18, maxHz = 2600) {
	// Decimate to ~4 kHz for tractable lags; low-pass first to avoid aliasing.
	const decim = Math.max(1, Math.floor(sr / 4000));
	const dsr = sr / decim;
	const lp = bandpass(samples, sr, 20, Math.min(1800, dsr / 2 - 100), 2);
	const len = Math.floor(lp.length / decim);
	const ds = new Float32Array(len);
	for (let i = 0; i < len; i++) ds[i] = lp[i * decim];

	let energy = 0;
	for (let i = 0; i < len; i++) energy += ds[i] * ds[i];
	if (energy < 1e-7) return { f0: 0, confidence: 0, clarity: 0 };

	const maxLag = Math.min(len - 2, Math.floor(dsr / minHz));
	const minLag = Math.max(2, Math.floor(dsr / maxHz));
	let bestLag = 0;
	let bestVal = -Infinity;
	const acf = new Float32Array(maxLag + 1);
	for (let lag = minLag; lag <= maxLag; lag++) {
		let s = 0;
		for (let i = 0; i + lag < len; i++) s += ds[i] * ds[i + lag];
		acf[lag] = s / (len - lag);
		if (acf[lag] > bestVal) { bestVal = acf[lag]; bestLag = lag; }
	}
	const zeroLag = acf[minLag] || 1e-9;
	let clarity = Math.max(0, Math.min(1, bestVal / Math.max(1e-9, energy / len)));
	// Prefer the shortest lag whose ACF is within 88 % of the maximum (avoids
	// octave-down errors on harmonic-rich purrs).
	for (let lag = minLag; lag <= maxLag; lag++) {
		if (acf[lag] >= bestVal * 0.88 && acf[lag] > acf[lag - 1] && acf[lag] >= acf[lag + 1]) {
			bestLag = lag;
			bestVal = acf[lag];
			break;
		}
	}
	let refined = bestLag;
	if (bestLag > 1 && bestLag < maxLag) {
		const y0 = acf[bestLag - 1];
		const y1 = acf[bestLag];
		const y2 = acf[bestLag + 1];
		const denom = 2 * (2 * y1 - y0 - y2);
		if (Math.abs(denom) > 1e-12) refined = bestLag + (y2 - y0) / denom;
	}
	return {
		f0: dsr / Math.max(1, refined),
		clarity,
		confidence: clarity,
		zeroLag
	};
}

/** Real cepstrum → cepstral peak prominence (dB), a validated dysphonia index. */
export function cepstralPeakProminence(samples, sr) {
	const N = 4096;
	const re = new Float32Array(N);
	const im = new Float32Array(N);
	const n = Math.min(N, samples.length);
	for (let i = 0; i < n; i++) re[i] = samples[i] * hann(i, N);
	fftInPlace(re, im);
	for (let i = 0; i < N; i++) {
		const mag = Math.max(1e-9, Math.hypot(re[i], im[i]));
		re[i] = Math.log(mag);
		im[i] = 0;
	}
	// IFFT via conjugate trick
	for (let i = 0; i < N; i++) im[i] = -im[i];
	fftInPlace(re, im);
	for (let i = 0; i < N; i++) { re[i] /= N; im[i] = -im[i] / N; }

	const minQ = Math.floor(sr / 2200);
	const maxQ = Math.min(N >> 1, Math.floor(sr / 18));
	let peak = -Infinity;
	let peakQ = 0;
	let sum = 0;
	let count = 0;
	for (let q = minQ; q < maxQ; q++) {
		const v = re[q];
		sum += v;
		count++;
		if (v > peak) { peak = v; peakQ = q; }
	}
	const avg = sum / Math.max(1, count);
	return { cpp: peak - avg, peakQ, periodMs: (peakQ / sr) * 1000, f0FromCepstrum: peakQ > 0 ? sr / peakQ : 0 };
}

/** Harmonic-to-noise ratio via ACF peak / (1 - peak). */
export function harmonicToNoise(samples, sr) {
	const { clarity } = estimateF0(samples, sr);
	const hnr = 10 * Math.log10(Math.max(1e-4, clarity) / Math.max(1e-4, 1 - clarity));
	return Math.max(-12, Math.min(34, hnr));
}

export function spectralCentroid(samples, sr, fftSize = 4096) {
	const re = new Float32Array(fftSize);
	const im = new Float32Array(fftSize);
	const n = Math.min(fftSize, samples.length);
	for (let i = 0; i < n; i++) re[i] = samples[i] * hann(i, fftSize);
	fftInPlace(re, im);
	const binHz = sr / fftSize;
	let num = 0;
	let den = 0;
	for (let i = 1; i < fftSize >> 1; i++) {
		const mag = Math.hypot(re[i], im[i]);
		num += mag * i * binHz;
		den += mag;
	}
	return den > 1e-9 ? num / den : 0;
}

export function burstStatistics(samples, sr) {
	// Frame-rate envelope: 8 ms RMS frames, median-smoothed over ~120 ms so a
	// 26 Hz purr pulse-train (~38 ms period) reads as continuous tone instead of
	// a burst train. Median smoothing runs over frames, never over raw samples.
	const frame = Math.max(24, Math.round(sr * 0.008));
	const frames = Math.max(1, Math.floor(samples.length / frame));
	const raw = new Float32Array(frames);
	for (let i = 0; i < frames; i++) {
		let acc = 0;
		const from = i * frame;
		const to = Math.min(samples.length, from + frame);
		for (let j = from; j < to; j++) acc += samples[j] * samples[j];
		// RMS — not peak — so a 26 Hz pulse train has a flat frame envelope.
		raw[i] = Math.sqrt(acc / Math.max(1, to - from));
	}
	const smoothWin = Math.max(3, (Math.round((0.12 * sr) / frame) | 1));
	const env = medianSmooth(raw, smoothWin);
	// Onset detection runs on a shorter (48 ms) median window: long enough to
	// suppress a 26 Hz purr ripple, short enough to resolve a 7 Hz sneeze train.
	const envFast = medianSmooth(raw, Math.max(3, (Math.round((0.048 * sr) / frame) | 1)));

	const sorted = Array.from(env).sort((a, b) => a - b);
	const q = (pct) => sorted[Math.min(sorted.length - 1, Math.floor(pct * sorted.length))] || 0;
	const floor = q(0.2);
	const peak = q(0.97);
	const fastSorted = Array.from(envFast).sort((a, b) => a - b);
	const qf = (pct) => fastSorted[Math.min(fastSorted.length - 1, Math.floor(pct * fastSorted.length))] || 0;
	const hi = qf(0.2) + (qf(0.97) - qf(0.2)) * 0.5;
	const lo = qf(0.2) + (qf(0.97) - qf(0.2)) * 0.2;
	// Duty factor = fraction of frames within 10 dB of the loudest level. A steady
	// tone (purr, stertor) sits near 1.0; a burst train (cough, sneeze) spends most
	// of its frames down in the decay tail.
	const gate = Math.max(floor, peak * 0.32);
	let duty = 0;
	for (let i = 0; i < env.length; i++) if (env[i] >= gate) duty++;
	const frameRate = sr / frame;
	const minGap = Math.max(1, Math.round(frameRate * 0.07));
	let onsets = 0;
	let armed = true;
	let armedLevel = 0;
	let lastOnset = -minGap;
	for (let i = 0; i < envFast.length; i++) {
		const v = envFast[i];
		if (v < lo) {
			armed = true;
			armedLevel = v;
			continue;
		}
		if (!armed || v < hi) continue;
		// Require a ≥ 6 dB rise out of the local trough, so the shallow ripple of a
		// continuous purr is never counted as a burst train.
		if (v < armedLevel * 1.9) continue;
		if (i - lastOnset < minGap) continue;
		onsets++;
		lastOnset = i;
		armed = false;
	}
	const durationS = samples.length / sr;
	return {
		burstRate: onsets / Math.max(0.2, durationS),
		dutyFactor: duty / Math.max(1, env.length),
		activeRatio: duty / Math.max(1, env.length),
		env,
		envFrameRate: frameRate,
		peakAmplitude: peak,
		noiseFloor: floor
	};
}

/** Full feature vector for a mono Float32Array. */
export function extractFeatures(samples, sr = SAMPLE_RATE) {
	const clean = normalize(bandpass(samples, sr, 18, 7000, 2), 0.85);
	const { f0, clarity } = estimateF0(clean, sr);
	const cep = cepstralPeakProminence(clean, sr);
	const centroid = spectralCentroid(clean, sr);
	const hnr = harmonicToNoise(clean, sr);
	const bursts = burstStatistics(clean, sr);
	const bands = bandEnergies(clean, sr);
	const rmsDb = dbfs(rms(clean));
	const total = Math.max(1e-9, bands.total);

	return {
		f0,
		clarity,
		cpp: cep.cpp,
		f0Cepstrum: cep.f0FromCepstrum,
		centroid,
		hnr,
		burstRate: bursts.burstRate,
		dutyFactor: bursts.dutyFactor,
		rmsDb,
		bands,
		lowRatio: bands.low / total,
		midRatio: bands.mid / total,
		highRatio: bands.high / total,
		topRatio: bands.top / total,
		stertorRatio: bands.stertorEnergy / total,
		stridorRatio: bands.stridorEnergy / total,
		durationS: samples.length / sr,
		sr
	};
}

/* =========================================================================
 * 4. CLASSIFIER
 * ========================================================================= */
function softMembership(value, lo, hi, slack = 0.55) {
	if (!isFinite(value)) return 0;
	if (value >= lo && value <= hi) return 1;
	const span = Math.max(1e-6, hi - lo);
	const pad = span * slack;
	if (value < lo) return Math.max(0, 1 - (lo - value) / pad);
	return Math.max(0, 1 - (value - hi) / pad);
}

function logMembership(value, lo, hi, slack = 0.7) {
	const v = Math.log10(Math.max(1e-6, value));
	return softMembership(v, Math.log10(lo), Math.log10(hi), slack);
}

const FEATURE_WEIGHTS = { f0: 1.5, centroid: 1.15, hnr: 0.85, burst: 1.05, duty: 0.9, lowRatio: 0.8, midRatio: 0.55, cpp: 0.6 };

/**
 * Rank all signatures against a feature vector, with species priors.
 * @returns {Array<{key,label,confidence,species,notes}>} sorted desc
 */
export function classifySignature(features, species = 'dog') {
	const f = features;
	const scored = ACOUSTIC_SIGNATURES.map((sig) => {
		const i = sig.ideal;
		const parts = {
			f0: logMembership(f.f0, Math.max(8, i.f0 * 0.8), i.f0 * 1.25, 0.35),
			centroid: logMembership(f.centroid, Math.max(30, i.centroid * 0.65), i.centroid * 1.55, 0.45),
			hnr: softMembership(f.hnr, i.hnr - 3, i.hnr + 3.5, 0.6),
			burst: softMembership(f.burstRate, Math.max(0, i.burst * 0.6), i.burst * 1.6, 0.5),
			duty: softMembership(f.dutyFactor, Math.max(0, i.duty * 0.65), Math.min(1, i.duty * 1.4 + 0.05), 0.5),
			lowRatio: softMembership(f.lowRatio, Math.max(0, i.lowRatio * 0.5), Math.min(1, i.lowRatio * 1.8 + 0.05), 0.5),
			midRatio: softMembership(f.midRatio, Math.max(0, i.midRatio * 0.55), Math.min(1, i.midRatio * 1.65 + 0.05), 0.5),
			cpp: softMembership(f.cpp, 0.4, 6.5, 1.2)
		};
		let acc = 0;
		let weightSum = 0;
		for (const [k, w] of Object.entries(FEATURE_WEIGHTS)) {
			acc += (parts[k] ?? 0.4) * w;
			weightSum += w;
		}
		let score = acc / weightSum;

		// Species priors
		if (sig.species === species) score *= 1.32;
		else if (sig.species === 'any') score *= 0.92;
		else score *= 0.62;

		// Structural disambiguation rules (clinically hard-wired)
		if (sig.key === 'purr' && f.f0 > 60) score *= 0.08;
		if (sig.key === 'purr' && f.lowRatio < 0.1) score *= 0.45;
		if (sig.key === 'kennel_cough' && f.burstRate > 4.2) score *= 0.45;
		if (sig.key === 'kennel_cough' && f.centroid < 550) score *= 0.35;
		if (sig.key === 'reverse_sneeze' && f.burstRate < 2.6) score *= 0.45;
		if (sig.key === 'reverse_sneeze' && f.centroid > 700) score *= 0.4;
		if (sig.key === 'reverse_sneeze' && f.hnr > 8) score *= 0.5;
		if (sig.key === 'boas_stridor' && f.centroid < 800) score *= 0.2;
		if (sig.key === 'boas_stertor' && f.centroid > 500) score *= 0.15;
		if (sig.key === 'feline_wheeze' && f.hnr > -2) score *= 0.4;
		if (sig.key === 'feline_wheeze' && f.midRatio < 0.4) score *= 0.5;
		// A sustained, well-voiced clip is not an off-target goose honk.
		if (sig.key === 'goose_honk' && f.dutyFactor > 0.5) score *= 0.45;

		return {
			key: sig.key,
			label: sig.label,
			short: sig.short,
			icon: sig.icon,
			species: sig.species,
			clinical: sig.clinical,
			score,
			confidence: 0
		};
	});

	const sum = scored.reduce((a, b) => a + Math.pow(b.score, 3.2), 0) || 1;
	for (const s of scored) s.confidence = (Math.pow(s.score, 3.2) / sum) * 100;
	scored.sort((a, b) => b.confidence - a.confidence);
	return scored;
}

/* =========================================================================
 * 5. BOAS FUNCTIONAL GRADING
 * ========================================================================= */
export function computeBOAS(features, { postExercise = false } = {}) {
	const total = Math.max(1e-9, features.bands.total);
	const stertorRatio = features.bands.stertorEnergy / total;
	const stridorRatio = features.bands.stridorEnergy / total;
	const asoi = (stridorRatio / Math.max(1e-9, stridorRatio + stertorRatio)) * 100;
	const exerciseFactor = postExercise ? 1.38 : 1;
	const severity = Math.min(100, (asoi * 0.62 + features.dutyFactor * 100 * 0.34) * exerciseFactor);

	let grade = 0;
	let label = 'Grade 0 — Clinically normal';
	let tone = 'ok';
	if (severity >= 62) { grade = 3; label = 'Grade III — Severe obstruction'; tone = 'bad'; }
	else if (severity >= 42) { grade = 2; label = 'Grade II — Moderate obstruction'; tone = 'warn'; }
	else if (severity >= 22) { grade = 1; label = 'Grade I — Mild obstruction'; tone = 'info'; }

	const actions = {
		0: ['No surgical referral indicated from acoustics alone.', 'Re-screen annually before heat exposure.'],
		1: ['Weight management + harness (no neck leads).', 'Re-run BOAS panel after a 3-minute trot test.'],
		2: ['Refer for airway assessment — consider nares widening and sacculectomy.', 'Avoid heat, stress and strenuous exercise.'],
		3: ['Urgent surgical referral — laryngeal collapse likely.', 'Pre-oxygenate; avoid acepromazine. Use opioid-sparing sedation protocol.']
	};

	return {
		stertorRatio,
		stridorRatio,
		stertorDb: features.bands.stertorDb,
		stridorDb: features.bands.stridorDb,
		asoi,
		severity,
		grade,
		label,
		tone,
		actions: actions[grade],
		postExercise
	};
}

/* =========================================================================
 * 6. PHYSICAL SIGNAL SYNTHESIS
 * ========================================================================= */
function synthPurr(rand, seconds, sr) {
	const n = Math.floor(seconds * sr);
	const out = new Float32Array(n);
	const f0 = 26.4;
	const formants = [
		{ f: 320, gain: 1.5, bw: 120 },
		{ f: 620, gain: 1.1, bw: 170 },
		{ f: 1180, gain: 0.5, bw: 260 }
	];
	const breath = 0.24;
	for (let i = 0; i < n; i++) {
		const t = i / sr;
		const cycle = 0.86 + 0.14 * Math.sin(2 * Math.PI * (0.29 * t) - Math.PI / 2);
		let v = 0;
		for (let h = 1; h <= 64; h++) {
			const f = f0 * h;
			if (f > 1400) break;
			let g = 1 / Math.pow(h, 0.92);
			for (const fm of formants) g += 0.55 * Math.exp(-Math.pow((f - fm.f) / fm.bw, 2)) * fm.gain;
			v += Math.sin(2 * Math.PI * f * t + h * 0.6) * g;
		}
		out[i] = v * 0.09 * cycle + (rand() - 0.5) * breath * 0.02;
	}
	return normalize(out, 0.82);
}

function synthBurstTrain(
	rand,
	seconds,
	sr,
	{ rate, center, bw, decay, thumpHz = 88, thumpGain = 0.5, jitter = 0.12, toneHz = 0, toneGain = 0, glide = 0.35, loHz = 0, hiHz = 0 }
) {
	const n = Math.floor(seconds * sr);
	const out = new Float32Array(n);
	const period = 1 / rate;
	const T = 0.22; // glide window for the tonal honk core
	for (let b = 0; b < rate * seconds; b++) {
		const t0 = b * period * (1 + (rand() - 0.5) * jitter);
		const start = Math.floor(t0 * sr);
		const len = Math.floor(Math.min(0.42, period * 1.4) * sr);
		for (let k = 0; k < len; k++) {
			const idx = start + k;
			if (idx >= n) break;
			const dt = k / sr;
			const noise = (rand() - 0.5) * 2;
			const envlp = Math.exp(-decay * dt);
			let carrier = Math.sin(2 * Math.PI * center * dt) * 0.45 + noise * (1 - toneGain) * 0.85;
			if (toneHz > 0 && toneGain > 0) {
				// downward-gliding pitched core = the "honk" of a tracheal cough
				const tg = Math.min(dt, T);
				const phase = 2 * Math.PI * (toneHz * dt - ((glide * toneHz) / (2 * T)) * tg * tg);
				const harmonic = Math.sin(phase) + 0.45 * Math.sin(2 * phase) + 0.18 * Math.sin(3 * phase);
				carrier += harmonic * toneGain;
			}
			const thump = Math.sin(2 * Math.PI * thumpHz * dt) * Math.exp(-14 * dt) * thumpGain;
			out[idx] += (carrier * envlp + thump) * 0.55;
		}
	}
	const lo = loHz || Math.max(60, center - bw);
	const hi = hiHz || center + bw;
	return normalize(bandpass(out, sr, lo, hi, 2), 0.84);
}

function synthBreathNoise(rand, seconds, sr, { breathHz, loHz, hiHz, resonance, gain = 1, toneHz = 0, vibrato = 0 }) {
	const n = Math.floor(seconds * sr);
	const noise = new Float32Array(n);
	for (let i = 0; i < n; i++) noise[i] = (rand() - 0.5) * 2;
	const shaped = bandpass(noise, sr, loHz, hiHz, 3);
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const t = i / sr;
		const phase = (t * breathHz) % 1;
		// asymmetric breath envelope: sharp inspiration, slower expiration
		const insp = phase < 0.42 ? Math.pow(Math.sin((phase / 0.42) * Math.PI), 1.6) : 0;
		const exp = phase >= 0.46 ? Math.pow(Math.sin(((phase - 0.46) / 0.54) * Math.PI), 1.3) : 0;
		const env = Math.max(insp, exp * 0.85);
		let v = shaped[i] * 0.85;
		if (resonance > 0) v += Math.sin(2 * Math.PI * resonance * t) * 0.24;
		if (toneHz > 0) {
			const vib = vibrato ? Math.sin(2 * Math.PI * 5.4 * t) * vibrato : 0;
			v += Math.sin(2 * Math.PI * (toneHz + vib) * t) * 0.5;
			v += Math.sin(2 * Math.PI * (toneHz * 2 + vib) * t) * 0.16;
		}
		out[i] = v * env * gain;
	}
	return normalize(out, 0.86);
}

function synthGoose(rand, seconds, sr) {
	const n = Math.floor(seconds * sr);
	const out = new Float32Array(n);
	const honks = [0.05, 0.42, 0.78];
	for (const h0 of honks) {
		const start = Math.floor(h0 * sr);
		const len = Math.floor(0.26 * sr);
		for (let k = 0; k < len; k++) {
			const idx = start + k;
			if (idx >= n) break;
			const dt = k / sr;
			const glide = 330 + 150 * Math.sin(Math.PI * (dt / 0.26));
			const env = Math.pow(Math.sin(Math.PI * (dt / 0.26)), 0.7);
			let v = 0;
			for (let h = 1; h <= 12; h++) {
				const f = glide * h;
				let g = 1 / Math.pow(h, 1.1);
				if (f > 760 && f < 1150) g *= 2.2;
				if (f > 1700 && f < 2100) g *= 1.7;
				v += Math.sin(2 * Math.PI * f * dt + h) * g;
			}
			out[idx] += (v * 0.12 + (rand() - 0.5) * 0.06) * env;
		}
	}
	return normalize(out, 0.8);
}

/**
 * Synthesise a canonical signature as mono Float32 PCM.
 * @param {string} key signature key
 * @param {{seconds?:number, sampleRate?:number, seed?:number}} opts
 */
export function synthesizeSignature(key, opts = {}) {
	const sr = opts.sampleRate || SAMPLE_RATE;
	const seconds = opts.seconds || 4.2;
	const rand = mulberry32(opts.seed ?? 0x51f15e);
	switch (key) {
		case 'purr':
			return synthPurr(rand, seconds, sr);
		case 'kennel_cough':
			return synthBurstTrain(rand, seconds, sr, { rate: 3.6, center: 1000, bw: 620, decay: 20, thumpHz: 92, thumpGain: 0.35, toneHz: 340, toneGain: 1.15, glide: 0.34, loHz: 200, hiHz: 2400 });
		case 'reverse_sneeze':
			return synthBurstTrain(rand, seconds, sr, { rate: 7.4, center: 430, bw: 250, decay: 34, thumpHz: 120, thumpGain: 0.3, jitter: 0.18 });
		case 'boas_stertor':
			return synthBreathNoise(rand, seconds, sr, { breathHz: 0.42, loHz: 80, hiHz: 300, resonance: 132, gain: 1 });
		case 'boas_stridor':
			return synthBreathNoise(rand, seconds, sr, { breathHz: 0.46, loHz: 700, hiHz: 2200, resonance: 0, gain: 0.95, toneHz: 1180, vibrato: 24 });
		case 'feline_wheeze':
			return synthBreathNoise(rand, seconds, sr, { breathHz: 0.6, loHz: 520, hiHz: 1900, resonance: 0, gain: 0.75, toneHz: 780, vibrato: 18 });
		case 'goose_honk':
		default:
			return synthGoose(rand, seconds, sr);
	}
}

/* =========================================================================
 * 7. WEB AUDIO PLAYBACK
 * ========================================================================= */
let sharedCtx = null;

export function getAudioContext() {
	if (typeof window === 'undefined') return null;
	if (!sharedCtx) {
		const Ctx = window.AudioContext || window.webkitAudioContext;
		if (!Ctx) return null;
		sharedCtx = new Ctx();
	}
	if (sharedCtx.state === 'suspended') sharedCtx.resume().catch(() => {});
	return sharedCtx;
}

/**
 * Play PCM samples. Returns { stop(), promise } — stop is idempotent.
 */
export function playSamples(samples, sampleRate = SAMPLE_RATE, { onEnd } = {}) {
	const ctx = getAudioContext();
	if (!ctx) return { stop() {}, promise: Promise.resolve(), available: false };
	const buffer = ctx.createBuffer(1, samples.length, sampleRate);
	buffer.copyToChannel(samples instanceof Float32Array ? samples : new Float32Array(samples), 0);
	const src = ctx.createBufferSource();
	src.buffer = buffer;
	const gain = ctx.createGain();
	gain.gain.setValueAtTime(0.9, ctx.currentTime);
	src.connect(gain).connect(ctx.destination);
	let stopped = false;
	const promise = new Promise((resolve) => {
		src.onended = () => {
			if (onEnd) onEnd();
			resolve();
		};
	});
	src.start();
	return {
		available: true,
		stop() {
			if (stopped) return;
			stopped = true;
			try { src.stop(); } catch { /* already ended */ }
		},
		promise
	};
}

/* =========================================================================
 * 8. STFT WATERFALL DATA (for canvas rendering)
 * ========================================================================= */
export function buildWaterfall(samples, sr = SAMPLE_RATE, { fftSize = 1024, hop = 256, maxHz = 6000 } = {}) {
	const frames = stftFrames(samples, fftSize, hop);
	const binHz = sr / fftSize;
	const bins = Math.max(8, Math.floor(maxHz / binHz));
	const rows = [];
	let globalMax = 1e-9;
	for (const f of frames) {
		const row = new Float32Array(bins);
		for (let i = 0; i < bins; i++) {
			const mag = f.mag[i] || 0;
			row[i] = 20 * Math.log10(Math.max(1e-8, mag));
			if (row[i] > globalMax) globalMax = row[i];
		}
		rows.push(row);
	}
	return { rows, bins, binHz, maxDb: globalMax, minDb: globalMax - 62, frameTimeS: hop / sr };
}

export const FREQUENCY_LANDMARKS = [26, 80, 280, 500, 900, 1800, 3000, 6000];
