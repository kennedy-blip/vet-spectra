/**
 * VET-SPECTRA · quadrupedGaitKinematicsEngine.js
 * ---------------------------------------------------------------------------
 * Fourier-based quadruped lameness kinematics.
 *
 * Clinical basis: head-nod and pelvic-hike accelerometry (IMU at the poll and
 * the tuber sacrale) decompose into stride-frequency harmonics. A sound
 * quadruped's vertical oscillation is dominated by the SECOND harmonic of the
 * stride (2 loadings per stride for a trot). Lameness injects an asymmetric
 * FIRST-harmonic component:
 *
 *      A1 (primary / lameness) , A2 (secondary / sound) , LAI = A1/(A1+A2)
 *
 *   LAI  < 6 %  → sound
 *   6–12 %      → subtle, barely detectable
 *   12–20 %     → mild weight-bearing lameness
 *   20–30 %     → moderate weight-bearing
 *   30–45 %     → severe weight-bearing
 *   > 45 %      → non-weight-bearing
 *
 * Also implements the vector-sum magnitude, ΔZmax/ΔZmin of the affected limb,
 * phase-based limb localisation (which of the four limbs), impact vs push-off
 * classification, AAHA 0–5 lameness grading, CSU canine chronic pain scale and
 * the 5-action-unit Feline Grimace Scale.
 * ---------------------------------------------------------------------------
 */

import { bandpass, mulberry32 } from './dspKernels.js';

export const MODEL_VERSION = 'vet-spectra/gait-27.0.0';

/* =========================================================================
 * 1. LIMB DEFINITIONS
 * ========================================================================= */
export const LIMBS = [
	{ key: 'LF', label: 'Left Fore', short: 'LF', group: 'fore', phase: 0.0 },
	{ key: 'RF', label: 'Right Fore', short: 'RF', group: 'fore', phase: 0.5 },
	{ key: 'LH', label: 'Left Hind', short: 'LH', group: 'hind', phase: 0.25 },
	{ key: 'RH', label: 'Right Hind', short: 'RH', group: 'hind', phase: 0.75 }
];

export const LIMB_BY_KEY = Object.fromEntries(LIMBS.map((l) => [l.key, l]));

/* =========================================================================
 * 2. GAIT PROFILES (simulator presets)
 * ========================================================================= */
/**
 * `head` / `pelvis` amplitude fields are millimetres of vertical displacement.
 * `lameLimb` drives limb kinematics + the avatar highlight.
 */
export const GAIT_PROFILES = [
	{
		key: 'sound_walk',
		label: 'Sound Walk · 4-beat lateral sequence',
		short: 'Sound Walk',
		strideHz: 2.0,
		duty: 0.64,
		head: { dc: 12, a1: 0.22, a2: 5.4, phi1: 0.2, phi2: 0.9 },
		pelvis: { dc: 9, a1: 0.2, a2: 4.8, phi1: 2.4, phi2: 1.1 },
		lameLimb: null,
		note: 'Reference gait. Head-nod A1 is tiny; the 2× stride harmonic dominates.',
		severity: 'normal'
	},
	{
		key: 'sound_trot',
		label: 'Sound Trot · 2-beat diagonal',
		short: 'Sound Trot',
		strideHz: 2.9,
		duty: 0.42,
		head: { dc: 14, a1: 0.32, a2: 6.8, phi1: 0.1, phi2: 0.4 },
		pelvis: { dc: 10, a1: 0.28, a2: 6.1, phi1: 2.7, phi2: 0.8 },
		lameLimb: null,
		note: 'High vertical excursion but symmetric. LAI stays under 6 %.',
		severity: 'normal'
	},
	{
		key: 'left_fore_3',
		label: 'Left Forelimb Lameness · grade 3',
		short: 'LF Lameness',
		strideHz: 2.6,
		duty: 0.36,
		head: { dc: 11, a1: 1.9, a2: 5.6, phi1: 2.98, phi2: 0.7 },
		pelvis: { dc: 8, a1: 0.22, a2: 5.4, phi1: 2.5, phi2: 1.0 },
		lameLimb: 'LF',
		note: 'Classic head nod — the head drops as the sound right forelimb takes load.',
		severity: 'moderate'
	},
	{
		key: 'right_hind_4',
		label: 'Right Hindlimb Lameness · grade 4',
		short: 'RH Lameness',
		strideHz: 3.1,
		duty: 0.33,
		head: { dc: 12, a1: 0.3, a2: 6.2, phi1: 1.4, phi2: 0.6 },
		pelvis: { dc: 7, a1: 3.2, a2: 5.8, phi1: 1.52, phi2: 0.35 },
		lameLimb: 'RH',
		note: 'Pelvic hike with reduced hip extension — hip dysplasia or cruciate rupture.',
		severity: 'severe'
	},
	{
		key: 'bilateral_stifle',
		label: 'Bilateral Stifle Disease · bunny-hop',
		short: 'Bilateral Stifle',
		strideHz: 2.2,
		duty: 0.5,
		head: { dc: 16, a1: 1.2, a2: 9.4, phi1: 1.1, phi2: 0.2 },
		pelvis: { dc: 12, a1: 2.4, a2: 10.2, phi1: 4.41, phi2: 0.2 },
		lameLimb: 'LH',
		note: 'Both hindlimbs load together (bunny hop) — the stacked 2nd harmonic breaks the phase model.',
		severity: 'moderate'
	}
];

export function getGaitProfile(key) {
	return GAIT_PROFILES.find((p) => p.key === key) || GAIT_PROFILES[0];
}

/* =========================================================================
 * 3. SIGNAL SIMULATION
 * ========================================================================= */
/**
 * Synthesise poll + tuber-sacrale accelerometry (mm of vertical excursion).
 * Frame rate defaults to 120 Hz (typical IMU stream).
 */
export function simulateGait(profileKey, { seconds = 6, fs = 120, seed = 0x9a17 } = {}) {
	const p = getGaitProfile(profileKey);
	const rand = mulberry32(seed);
	const n = Math.floor(seconds * fs);
	const t = new Float32Array(n);
	const head = new Float32Array(n);
	const pelvis = new Float32Array(n);
	// Small stride-frequency jitter so the DFT is not unrealistically clean.
	const f = p.strideHz * (1 + (rand() - 0.5) * 0.01);

	for (let i = 0; i < n; i++) {
		const time = i / fs;
		t[i] = time;
		const w = 2 * Math.PI * f;
		head[i] =
			p.head.dc +
			p.head.a1 * Math.sin(w * time + p.head.phi1) +
			p.head.a2 * Math.sin(2 * w * time + p.head.phi2) +
			0.45 * Math.sin(3 * w * time + 1.2) +
			(rand() - 0.5) * 0.55 +
			0.25 * Math.sin(2 * Math.PI * 0.21 * time);
		pelvis[i] =
			p.pelvis.dc +
			p.pelvis.a1 * Math.sin(w * time + p.pelvis.phi1) +
			p.pelvis.a2 * Math.sin(2 * w * time + p.pelvis.phi2) +
			0.4 * Math.sin(3 * w * time + 0.4) +
			(rand() - 0.5) * 0.5 +
			0.2 * Math.sin(2 * Math.PI * 0.17 * time + 1.3);
	}

	return {
		profile: p,
		key: p.key,
		fs,
		seconds,
		strideHz: f,
		t,
		head,
		pelvis,
		strides: seconds * f
	};
}

/* =========================================================================
 * 4. FOURIER DECOMPOSITION
 * ========================================================================= */
/**
 * Harmonic amplitudes/phases at integer multiples of `baseFreq`, computed with
 * a Hann-windowed DFT (least-squares equivalent for a fixed frequency grid).
 */
export function fourierCoefficients(signal, fs, baseFreq, harmonics = 4) {
	const n = signal.length;
	const window = new Float32Array(n);
	let wsum = 0;
	let meanVal = 0;
	for (let i = 0; i < n; i++) {
		window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
		wsum += window[i];
		meanVal += signal[i] * window[i];
	}
	const dc = meanVal / Math.max(1e-9, wsum);
	const out = [];
	for (let h = 1; h <= harmonics; h++) {
		const w = 2 * Math.PI * baseFreq * h;
		let re = 0;
		let im = 0;
		for (let i = 0; i < n; i++) {
			const v = (signal[i] - dc) * window[i];
			re += v * Math.cos((w * i) / fs);
			im += v * Math.sin((w * i) / fs);
		}
		const amp = (2 * Math.hypot(re, im)) / Math.max(1e-9, wsum);
		out.push({ n: h, amp, phase: Math.atan2(im, re), re, im });
	}
	return { dc, harmonics: out, a1: out[0]?.amp ?? 0, a2: out[1]?.amp ?? 0, phi1: out[0]?.phase ?? 0, phi2: out[1]?.phase ?? 0 };
}

/** Lameness Asymmetry Index (%) from the first two stride harmonics. */
export function lamenessAsymmetryIndex(a1, a2) {
	const denom = a1 + a2;
	if (denom <= 1e-9) return 0;
	return (a1 / denom) * 100;
}

/** Harmonic polar vector sum — total asymmetric displacement magnitude. */
export function harmonicVectorSum(a1, a2) {
	return Math.hypot(a1, a2);
}

/**
 * Localise the lame limb from the first-harmonic phase.
 * The nod/hike peak occurs roughly half a stride after the lame limb loads, so
 * the phase is rotated by half a cycle and matched against each limb's contact
 * phase (LF 0.00, RF 0.50, LH 0.25, RH 0.75).
 */
export function limbPhaseToSide(group, phase1) {
	let cycle = (Math.PI / 2 - phase1) / (2 * Math.PI);
	cycle = ((cycle % 1) + 1) % 1;
	const lamePhase = (cycle + 0.5) % 1;
	const angle = (a, b) => {
		const d = Math.abs(a - b) % 1;
		return Math.min(d, 1 - d);
	};
	if (group === 'fore') return angle(lamePhase, 0) <= angle(lamePhase, 0.5) ? 'LF' : 'RF';
	return angle(lamePhase, 0.25) <= angle(lamePhase, 0.75) ? 'LH' : 'RH';
}

/* =========================================================================
 * 5. LIMB KINEMATICS — ΔZmax / ΔZmin AND PEAK VERTICAL FORCE
 * ========================================================================= */
export function limbKinematics(profile, limbKey) {
	const limb = LIMB_BY_KEY[limbKey];
	const isLame = profile.lameLimb === limbKey;
	const isHind = limb.group === 'hind';
	const stridePeriod = 1000 / profile.strideHz; // ms

	// Stance duty is shortened on the lame limb (protective unloading).
	const duty = isLame ? Math.max(0.22, profile.duty * 0.62) : profile.duty;
	const phaseDelay = limb.phase * 360; // degrees within stride

	// Vertical paw excursion: extended in swing, compressed in stance.
	const baseExcursion = isHind ? 42 : 36; // mm
	const excursion = isLame ? baseExcursion * 1.35 : baseExcursion;
	const deltaZmax = excursion;
	const deltaZmin = isLame ? excursion * 0.34 : excursion * 0.12;

	const peakVerticalForce = isLame ? 0.62 : isHind ? 0.86 : 1.0; // fraction of bodyweight

	return {
		limb: limb.key,
		label: limb.label,
		group: limb.group,
		isLame,
		duty,
		stanceMs: duty * stridePeriod,
		swingMs: (1 - duty) * stridePeriod,
		phaseDelay,
		deltaZmax,
		deltaZmin,
		peakVerticalForce,
		stridePeriodMs: stridePeriod
	};
}

/* =========================================================================
 * 6. MASTER ANALYSIS
 * ========================================================================= */
export const AAHA_SCALE = [
	{ score: 0, label: 'Normal', desc: 'No detectable asymmetry at walk or trot.' },
	{ score: 1, label: 'Barely detectable', desc: 'Inconsistent, only visible on tight circles or after exercise.' },
	{ score: 2, label: 'Mild weight-bearing', desc: 'Consistent nod/hike, still fully weight-bearing.' },
	{ score: 3, label: 'Moderate weight-bearing', desc: 'Obvious asymmetry, shortened stance on the affected limb.' },
	{ score: 4, label: 'Severe weight-bearing', desc: 'Head/pelvis dropped at stance; limb barely loaded.' },
	{ score: 5, label: 'Non-weight-bearing', desc: 'Limb held up — complete functional unloading.' }
];

export function aahaGradeFromLAI(lai) {
	if (lai < 6) return AAHA_SCALE[0];
	if (lai < 12) return AAHA_SCALE[1];
	if (lai < 20) return AAHA_SCALE[2];
	if (lai < 30) return AAHA_SCALE[3];
	if (lai < 45) return AAHA_SCALE[4];
	return AAHA_SCALE[5];
}

/**
 * Full gait report.
 * @param {string} profileKey
 * @param {{seconds?:number, fs?:number, bilateral?:boolean}} opts
 */
export function analyzeGait(profileKey, opts = {}) {
	const sim = simulateGait(profileKey, opts);
	const { fs, strideHz } = sim;
	const headSignal = bandpass(sim.head, fs, 0.4, 24, 2);
	const pelvisSignal = bandpass(sim.pelvis, fs, 0.4, 24, 2);

	const headF = fourierCoefficients(headSignal, fs, strideHz, 4);
	const pelvisF = fourierCoefficients(pelvisSignal, fs, strideHz, 4);

	const headLAI = lamenessAsymmetryIndex(headF.a1, headF.a2);
	const pelvisLAI = lamenessAsymmetryIndex(pelvisF.a1, pelvisF.a2);
	const dominant = headLAI >= pelvisLAI ? 'fore' : 'hind';
	const dominantLAI = Math.max(headLAI, pelvisLAI);
	const dominantF = dominant === 'fore' ? headF : pelvisF;

	// Below the 6 % LAI threshold the phase is noise-driven, so no limb is claimed.
	const limbKey = dominantLAI < 6 ? null : limbPhaseToSide(dominant, dominantF.phi1);
	const aaha = aahaGradeFromLAI(dominantLAI);

	// Impact (loading-phase) vs push-off (terminal-stance) asymmetry: a phase
	// near 0/π indicates the asymmetry peaks at impact; ±π/2 indicates push-off.
	const phaseDeg = (((dominantF.phi1 * 180) / Math.PI) % 360 + 360) % 360;
	const impactPhase = Math.abs(Math.sin((phaseDeg * Math.PI) / 180));
	const asymmetryTiming = impactPhase > 0.72 ? 'impact / loading' : impactPhase < 0.34 ? 'push-off / propulsion' : 'mid-stance';

	const limbReports = LIMBS.map((l) => limbKinematics(sim.profile, l.key));
	const lame = limbReports.find((l) => l.isLame) || null;

	// Stance fraction symmetry between the lame and its contralateral partner.
	let stanceAsymmetryPct = 0;
	if (lame) {
		const CONTRALATERAL = { LF: 'RF', RF: 'LF', LH: 'RH', RH: 'LH' };
		const partner = limbReports.find((l) => l.limb === CONTRALATERAL[lame.limb]);
		stanceAsymmetryPct = ((partner.stanceMs - lame.stanceMs) / partner.stanceMs) * 100;
	}

	const verticalImpulseRatio = lame
		? (lame.peakVerticalForce * lame.duty) / Math.max(1e-6, 1.0 * sim.profile.duty)
		: 1;

	return {
		sim,
		profile: sim.profile,
		head: {
			dc: headF.dc,
			a1: headF.a1,
			a2: headF.a2,
			a3: headF.harmonics[2]?.amp ?? 0,
			phi1: headF.phi1,
			phi2: headF.phi2,
			lai: headLAI,
			vectorSum: harmonicVectorSum(headF.a1, headF.a2),
			harmonics: headF.harmonics,
			signal: headSignal
		},
		pelvis: {
			dc: pelvisF.dc,
			a1: pelvisF.a1,
			a2: pelvisF.a2,
			a3: pelvisF.harmonics[2]?.amp ?? 0,
			phi1: pelvisF.phi1,
			phi2: pelvisF.phi2,
			lai: pelvisLAI,
			vectorSum: harmonicVectorSum(pelvisF.a1, pelvisF.a2),
			harmonics: pelvisF.harmonics,
			signal: pelvisSignal
		},
		dominant,
		dominantLAI,
		limbKey: sim.profile.lameLimb || limbKey,
		phaseLimb: limbKey,
		aaha,
		asymmetryTiming,
		phaseDeg,
		stanceAsymmetryPct,
		verticalImpulseRatio,
		limbReports,
		deltaZmax: lame?.deltaZmax ?? 0,
		deltaZmin: lame?.deltaZmin ?? 0,
		verdict:
			dominantLAI < 6
				? 'Symmetric gait — no lameness detected'
				: `${dominant === 'fore' ? 'Forelimb' : 'Hindlimb'} lameness, ${LIMB_BY_KEY[sim.profile.lameLimb || limbKey].label}, AAHA ${aaha.score}/5`
	};
}

/* =========================================================================
 * 7. PAIN SCALES
 * ========================================================================= */
/** Colorado State University canine chronic pain — 4 severity items, 0–4. */
export const CSU_PAIN_ITEMS = [
	{ key: 'q1', label: 'Lameness at walk', anchors: ['None', 'Barely visible', 'Mild', 'Moderate', 'Severe / refuses'] },
	{ key: 'q2', label: 'Weight-bearing on affected limb', anchors: ['Full', 'Slight shift', 'Partial', 'Toe-touch', 'Non-weight-bearing'] },
	{ key: 'q3', label: 'Activity / willingness to rise', anchors: ['Normal', 'Slightly reduced', 'Reduced', 'Reluctant', 'Will not rise'] },
	{ key: 'q4', label: 'Pain behaviour (whimper, guarding)', anchors: ['None', 'Occasional', 'When touched', 'Spontaneous', 'Constant vocalisation'] }
];

export const CSU_THRESHOLD = 5;

export function scoreCsuPain(values) {
	const total = CSU_PAIN_ITEMS.reduce((acc, item) => acc + (Number(values?.[item.key]) || 0), 0);
	const max = CSU_PAIN_ITEMS.length * 4;
	const pct = (total / max) * 100;
	let band = 'Mild';
	if (total >= 12) band = 'Severe — multimodal analgesia now';
	else if (total >= CSU_THRESHOLD) band = 'Moderate — analgesic intervention indicated';
	else band = 'Mild / monitor';
	return {
		total,
		max,
		pct,
		band,
		intervene: total >= CSU_THRESHOLD,
		recommendation:
			total >= CSU_THRESHOLD
				? 'Start NSAID (or gabapentin if NSAID-contraindicated) + weight and exercise modification; re-score in 14 days.'
				: 'Continue monitoring. Re-score weekly; investigate if the score rises by ≥ 2 points.'
	};
}

/** Feline Grimace Scale — 5 action units, each 0 / 1 / 2. */
export const FELINE_GRIMACE_ITEMS = [
	{ key: 'ears', label: 'Ear position', anchors: ['Ears forward', 'Ears slightly apart', 'Ears flattened / rotated outward'] },
	{ key: 'orbital', label: 'Orbital tightening', anchors: ['Eyes open', 'Partially closed', 'Squinted / closed'] },
	{ key: 'muzzle', label: 'Muzzle tension', anchors: ['Relaxed', 'Slightly tense', 'Tense / drawn back'] },
	{ key: 'whiskers', label: 'Whisker position', anchors: ['Loose & curved', 'Slightly bunched', 'Bunched & forward'] },
	{ key: 'head', label: 'Head position', anchors: ['Above shoulder line', 'Level with shoulders', 'Below shoulders / tucked'] }
];

export const GRIMACE_THRESHOLD = 4;

export function scoreFelineGrimace(values) {
	const total = FELINE_GRIMACE_ITEMS.reduce((acc, item) => acc + (Number(values?.[item.key]) || 0), 0);
	const max = FELINE_GRIMACE_ITEMS.length * 2;
	const normalised = total / max;
	return {
		total,
		max,
		normalised,
		painPresent: total >= GRIMACE_THRESHOLD,
		band: total >= 7 ? 'Severe pain' : total >= GRIMACE_THRESHOLD ? 'Pain present (≥ 4/10)' : 'No pain indicated',
		recommendation:
			total >= GRIMACE_THRESHOLD
				? 'Analgesia indicated (buprenorphine 0.02 mg/kg IV/IM or robenacoxib 1–2 mg/kg SC). Re-score 30 min post-analgesia.'
				: 'No analgesia indicated by the grimace score alone; pair with the CSU pain scale and owner history.'
	};
}

/* =========================================================================
 * 8. AVATAR / PHASE DATA
 * ========================================================================= */
/** Normalised stance windows per limb for the animated quadruped avatar. */
export function stanceWindows(profile) {
	return LIMBS.map((l) => {
		const isLame = profile.lameLimb === l.key;
		const duty = isLame ? Math.max(0.22, profile.duty * 0.62) : profile.duty;
		return {
			key: l.key,
			label: l.label,
			group: l.group,
			start: l.phase,
			duty,
			isLame,
			peakForce: isLame ? 0.62 : l.group === 'hind' ? 0.86 : 1.0
		};
	});
}

export const GAIT_PRESET_KEYS = GAIT_PROFILES.map((p) => p.key);
