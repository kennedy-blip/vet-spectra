/**
 * VET-SPECTRA · tickScutalDermaAuditorEngine.js
 * ---------------------------------------------------------------------------
 * Dual-vector tick triage + dermal perfusion + veterinary billing auditor.
 *
 *  1. SCUTAL INDEX  SI = L_body / W_scutum  (dimensionless)
 *     Attachment duration is recovered by log-linear interpolation between
 *     published species-specific SI/time anchors (Piesman & Falco method).
 *
 *  2. TRANSMISSION WINDOWS
 *       0 – 16 h      low risk, tick removal only
 *      16 – 36 h      Anaplasma phagocytophilum competence
 *      ≥ 36 – 48 h    Borrelia burgdorferi + Babesia microti competence
 *     SI ≥ 2.5       "high-inoculation" flag (Lyme + Babesia co-infection)
 *
 *  3. GINGIVAL / CAPILLARY REFILL  — sRGB → CIELAB ΔE2000-lite classification
 *     of gingival erythema, pallor, icterus and cyanosis plus a CRT stopwatch.
 *
 *  4. QUOTE AUDITOR — 6 common procedures, regional multiplier, duplicate /
 *     unbundling / markup detection, insurance reimbursement maths.
 * ---------------------------------------------------------------------------
 */

export const MODEL_VERSION = 'vet-spectra/tick-27.0.0';

/* =========================================================================
 * 1. TICK SPECIES + SI ANCHORS
 * ========================================================================= */
export const TICK_SPECIES = [
	{
		key: 'ixodes_scapularis',
		label: 'Ixodes scapularis (deer tick / black-legged)',
		short: 'I. scapularis',
		region: 'North-eastern & upper-midwestern USA',
		anchors: [
			[1.0, 0],
			[1.12, 12],
			[1.28, 24],
			[1.55, 36],
			[1.9, 48],
			[2.4, 60],
			[3.0, 72],
			[3.4, 96]
		],
		pathogens: [
			{ key: 'borrelia', label: 'Borrelia burgdorferi (Lyme)', thresholdH: 36, highH: 48, note: 'Outer-surface protein C (OspC) up-regulation requires ~36 h of feeding; transmission is rare before 24 h.' },
			{ key: 'anaplasma', label: 'Anaplasma phagocytophilum', thresholdH: 16, highH: 24, note: 'Fastest of the Ixodes trio — transmission can occur from 16 h.' },
			{ key: 'babesia', label: 'Babesia microti (babesiosis)', thresholdH: 36, highH: 48, note: 'Sporozoite migration to salivary glands takes ~36–48 h.' },
			{ key: 'powassan', label: 'Powassan virus (rare)', thresholdH: 0.25, highH: 1, note: 'Transmission can occur within 15 minutes of attachment — removal alone is insufficient prophylaxis.' }
		]
	},
	{
		key: 'dermacentor_variabilis',
		label: 'Dermacentor variabilis (American dog tick)',
		short: 'D. variabilis',
		region: 'Central & eastern USA',
		anchors: [
			[1.0, 0],
			[1.1, 12],
			[1.22, 24],
			[1.45, 36],
			[1.75, 48],
			[2.2, 60],
			[2.7, 72],
			[3.1, 96]
		],
		pathogens: [
			{ key: 'rickettsia', label: 'Rickettsia rickettsii (RMSF)', thresholdH: 4, highH: 20, note: 'Salivary reactivation is rapid — RMSF can transmit after only 4–6 h of attachment.' },
			{ key: 'tularemia', label: 'Francisella tularensis (tularaemia)', thresholdH: 4, highH: 24, note: 'Low inoculum needed; handle the tick with gloves.' }
		]
	},
	{
		key: 'amblyomma_americanum',
		label: 'Amblyomma americanum (lone star tick)',
		short: 'A. americanum',
		region: 'South-central & eastern USA',
		anchors: [
			[1.0, 0],
			[1.08, 12],
			[1.2, 24],
			[1.4, 36],
			[1.65, 48],
			[2.05, 60],
			[2.5, 72],
			[2.9, 96]
		],
		pathogens: [
			{ key: 'ehrlichia', label: 'Ehrlichia chaffeensis (ehrlichiosis)', thresholdH: 24, highH: 36, note: 'Also the trigger for alpha-gal (red meat) sensitisation.' },
			{ key: 'stari', label: 'STARI / Borrelia lonestari', thresholdH: 24, highH: 48, note: 'Southern tick-associated rash illness — treat empirically if erythema migrans appears.' }
		]
	},
	{
		key: 'rhipicephalus_sanguineus',
		label: 'Rhipicephalus sanguineus (brown dog tick)',
		short: 'R. sanguineus',
		region: 'Worldwide, indoor kennels & homes',
		anchors: [
			[1.0, 0],
			[1.1, 18],
			[1.3, 36],
			[1.6, 54],
			[2.0, 72],
			[2.5, 96]
		],
		pathogens: [
			{ key: 'babesia_canis', label: 'Babesia canis vogeli', thresholdH: 24, highH: 48, note: 'Transstadial + transovarial transmission — a single engorged female can seed an entire litter.' },
			{ key: 'ehrlichia_canis', label: 'Ehrlichia canis', thresholdH: 24, highH: 48, note: 'Endemic in kennels; PCR at 2–3 weeks post-attachment.' }
		]
	}
];

export function getTickSpecies(key) {
	return TICK_SPECIES.find((s) => s.key === key) || TICK_SPECIES[0];
}

export const SPECIMEN_PRESETS = [
	{ key: 'unfed', label: 'Unfed adult (questing)', lengthMm: 3.1, widthMm: 2.95, colour: '#5b3a29', note: 'Flat scutum, no visible engorgement. Attached < 12 h if found on the patient.' },
	{ key: 'early', label: 'Early feeding (≈24 h)', lengthMm: 4.6, widthMm: 3.1, colour: '#6b3f2a', note: 'Slight scutal stretch, body beginning to dome.' },
	{ key: 'partial', label: 'Partially engorged (≈48 h)', lengthMm: 8.2, widthMm: 3.6, colour: '#7b4a30', note: 'Legs still visible laterally, scutum appears small relative to the body.' },
	{ key: 'engorged', label: 'Fully engorged (≥ 72 h)', lengthMm: 12.6, widthMm: 4.1, colour: '#8a5636', note: 'Bean-shaped, grey-blue tint, scutum is a tiny anterior shield.' }
];

/* =========================================================================
 * 2. SCUTAL INDEX → ATTACHMENT DURATION
 * ========================================================================= */
export function scutalIndex(lengthMm, widthMm) {
	const w = Math.max(0.2, Number(widthMm) || 0.2);
	const l = Math.max(0.2, Number(lengthMm) || 0.2);
	return l / w;
}

/**
 * Log-linear interpolation/extrapolation across the species anchor table.
 * Returns hours attached (0–120) plus the bracketing anchors for auditability.
 */
export function attachmentHoursFromSI(si, speciesKey = 'ixodes_scapularis') {
	const species = getTickSpecies(speciesKey);
	const anchors = species.anchors;
	const table = anchors.map(([s, h]) => [s, h]);
	const clamped = Math.max(0.5, Math.min(6, si));

	if (clamped <= table[0][0]) return { hours: 0, species, method: 'below-unfed-anchor' };
	const last = table[table.length - 1];
	if (clamped >= last[0]) {
		// Extrapolate using the final log-slope.
		const prev = table[table.length - 2];
		const slope = (last[1] - prev[1]) / Math.max(1e-6, Math.log(last[0] / prev[0]));
		const hours = last[1] + slope * Math.log(clamped / last[0]);
		return { hours: Math.max(0, Math.min(168, hours)), species, method: 'log-extrapolation' };
	}
	for (let i = 1; i < table.length; i++) {
		if (clamped <= table[i][0]) {
			const [s0, h0] = table[i - 1];
			const [s1, h1] = table[i];
			const frac = Math.log(clamped / s0) / Math.log(s1 / s0);
			return {
				hours: h0 + frac * (h1 - h0),
				species,
				method: 'log-interpolation',
				between: [[s0, h0], [s1, h1]]
			};
		}
	}
	return { hours: 0, species, method: 'fallback' };
}

/* =========================================================================
 * 3. TRANSMISSION RISK
 * ========================================================================= */
function logisticRisk(hours, thresholdH, scale = 7) {
	return 100 / (1 + Math.exp(-(hours - thresholdH) / scale));
}

export function transmissionRisk({ hours, speciesKey = 'ixodes_scapularis', si = 0 }) {
	const species = getTickSpecies(speciesKey);
	const pathogens = species.pathogens.map((p) => {
		const risk = logisticRisk(hours, p.thresholdH, p.key === 'powassan' ? 1.2 : 7);
		let level = 'low';
		if (hours >= p.highH) level = 'high';
		else if (hours >= p.thresholdH) level = 'moderate';
		return {
			...p,
			risk: Math.round(risk),
			level,
			status:
				hours >= p.highH
					? 'Transmission-competent'
					: hours >= p.thresholdH
					? 'Entering competence window'
					: 'Below competence threshold'
		};
	});

	const maxRisk = Math.max(...pathogens.map((p) => p.risk), 0);
	const highInoculation = si >= 2.5;
	const window = hours < 16 ? '0–16 h low-risk window' : hours < 36 ? '16–36 h Anaplasma window' : '≥ 36–48 h Lyme + Babesia window';

	let tone = 'ok';
	let verdict = 'Low transmission risk — remove the tick and clean the bite.';
	if (highInoculation || maxRisk >= 75) {
		tone = 'bad';
		verdict = 'High transmission risk — same-day veterinary assessment and serology/PCR timing plan required.';
	} else if (maxRisk >= 35) {
		tone = 'warn';
		verdict = 'Moderate transmission risk — start a 21-day watch for fever, lameness and erythema migrans.';
	}

	const actions = [];
	if (hours < 16) {
		actions.push('Remove with fine-tipped tweezers perpendicular to the skin; never squeeze the abdomen.');
		actions.push('Disinfect the bite, save the tick in a sealed tube for species/SI confirmation.');
	} else if (hours < 36) {
		actions.push('Remove and measure immediately — Anaplasma competence begins around 16 h.');
		actions.push('Baseline CBC + 4Dx SNAP; repeat at 3–4 weeks (seroconversion lag).');
	} else {
		actions.push('Same-day veterinary review: PCR for Borrelia / Babesia, doxycycline decision within 72 h.');
		actions.push('Watch for shifting-leg lameness, fever, lymphadenopathy and erythema migrans over 4 weeks.');
	}
	if (highInoculation) actions.push('SI ≥ 2.5 — high-inoculation bite: prioritise Lyme + Babesia co-infection testing.');
	if (hours >= 72) actions.push('Tick was likely attached for ≥ 3 days — treat as a confirmed exposure event regardless of symptoms.');

	return {
		hours,
		si,
		species,
		pathogens,
		maxRisk,
		highInoculation,
		window,
		tone,
		verdict,
		actions,
		band:
			hours < 16
				? { key: 'low', label: '0–16 h', tone: 'ok' }
				: hours < 36
				? { key: 'anaplasma', label: '16–36 h', tone: 'warn' }
				: { key: 'lyme', label: '≥ 36–48 h', tone: 'bad' }
	};
}

/** Hourly risk curves (0–96 h) for charting. */
export function buildRiskTimeline(speciesKey = 'ixodes_scapularis', hours = 96) {
	const species = getTickSpecies(speciesKey);
	const points = [];
	for (let h = 0; h <= hours; h += 1) {
		const row = { h };
		for (const p of species.pathogens) row[p.key] = logisticRisk(h, p.thresholdH, p.key === 'powassan' ? 1.2 : 7);
		points.push(row);
	}
	return { species, points };
}

/* =========================================================================
 * 4. GINGIVAL / CIELAB PERFUSION ANALYSIS
 * ========================================================================= */
export function srgbToLinear(c) {
	const v = c / 255;
	return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** sRGB (0–255) → CIELAB (D65). */
export function rgbToLab(r, g, b) {
	const R = srgbToLinear(r);
	const G = srgbToLinear(g);
	const B = srgbToLinear(b);
	const X = R * 0.4124 + G * 0.3576 + B * 0.1805;
	const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
	const Z = R * 0.0193 + G * 0.1192 + B * 0.9505;
	const Xn = 0.95047;
	const Yn = 1.0;
	const Zn = 1.08883;
	const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
	const fx = f(X / Xn);
	const fy = f(Y / Yn);
	const fz = f(Z / Zn);
	return {
		L: 116 * fy - 16,
		a: 500 * (fx - fy),
		b: 200 * (fy - fz)
	};
}

export function labToCss(L, a, b) {
	// Approximate inverse for swatch rendering only.
	const fy = (L + 16) / 116;
	const fx = fy + a / 500;
	const fz = fy - b / 200;
	const inv = (t) => {
		const t3 = t * t * t;
		return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787;
	};
	const X = 0.95047 * inv(fx);
	const Y = 1.0 * inv(fy);
	const Z = 1.08883 * inv(fz);
	let R = X * 3.2406 + Y * -1.5372 + Z * -0.4986;
	let G = X * -0.9689 + Y * 1.8758 + Z * 0.0415;
	let B = X * 0.0557 + Y * -0.204 + Z * 1.057;
	const gam = (c) => {
		const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055;
		return Math.round(Math.max(0, Math.min(1, v)) * 255);
	};
	R = gam(R); G = gam(G); B = gam(B);
	return `rgb(${R}, ${G}, ${B})`;
}

export const GINGIVA_CLASSES = [
	{ key: 'normal', label: 'Normal pink', tone: 'ok', desc: 'Healthy gingival mucosa — L* 55–75, a* 22–38, b* 10–24.' },
	{ key: 'gingivitis', label: 'Gingivitis / erythema', tone: 'warn', desc: 'Raised a* (redness) and chroma — active periodontal inflammation or glossitis.' },
	{ key: 'pallor', label: 'Pallor — anaemia / hypoperfusion', tone: 'bad', desc: 'High L*, low a*: pale mucosa. Check PCV/TPC and perfusion parameters.' },
	{ key: 'icterus', label: 'Icterus — jaundice', tone: 'bad', desc: 'Raised b* (yellow): haemolysis, hepatobiliary disease or sepsis.' },
	{ key: 'cyanosis', label: 'Cyanosis — hypoxaemia', tone: 'bad', desc: 'Low L*, desaturated b*: right-to-left shunt, severe hypoxaemia or methaemoglobinaemia.' },
	{ key: 'congestion', label: 'Congestion — hyperaemia', tone: 'warn', desc: 'Very high a* and low L*: vasodilation, shock or heat stress.' }
];

/**
 * Classify gingival colour + CRT.
 * @param {{L:number,a:number,b:number,crtSeconds?:number}} input
 */
export function classifyGingiva({ L = 62, a = 30, b = 18, crtSeconds = 1.2 }) {
	const chroma = Math.hypot(a, b);
	const hue = (Math.atan2(b, a) * 180) / Math.PI;
	const scores = {
		gingivitis: Math.max(0, (a - 34) * 4 + (chroma - 38) * 1.4),
		pallor: Math.max(0, (L - 68) * 3.4 + (26 - a) * 3),
		icterus: Math.max(0, (b - 26) * 5.2),
		cyanosis: Math.max(0, (52 - L) * 3 + Math.max(0, 10 - b) * 2.4),
		congestion: Math.max(0, (a - 44) * 4 + (52 - L) * 1.2),
		normal: 12
	};
	let best = 'normal';
	let bestScore = scores.normal;
	for (const key of ['gingivitis', 'pallor', 'icterus', 'cyanosis', 'congestion']) {
		if (scores[key] > bestScore) {
			bestScore = scores[key];
			best = key;
		}
	}
	const cls = GINGIVA_CLASSES.find((c) => c.key === best) || GINGIVA_CLASSES[0];

	let crtTone = 'ok';
	let crtVerdict = 'CRT ≤ 2 s — normal peripheral perfusion.';
	if (crtSeconds > 3) { crtTone = 'bad'; crtVerdict = 'CRT > 3 s — decompensated shock. Start fluid resuscitation.'; }
	else if (crtSeconds > 2) { crtTone = 'warn'; crtVerdict = 'CRT 2–3 s — prolonged; assess hydration, blood pressure and temperature.'; }

	const override = crtTone === 'bad' ? 'bad' : cls.tone === 'bad' ? 'bad' : crtTone === 'warn' ? 'warn' : cls.tone;
	const actions = [];
	if (best === 'pallor') actions.push('PCV/TPC + blood smear for regeneration; check systolic blood pressure.');
	if (best === 'icterus') actions.push('Bilirubin (total + direct), ALT/ALP, CBC for haemolysis; abdominal ultrasound.');
	if (best === 'cyanosis') actions.push('SpO₂ + arterial blood gas; consider contrast echo for right-to-left shunt.');
	if (best === 'gingivitis') actions.push('Dental charting + full-mouth radiographs; scale and polish under anaesthesia.');
	if (best === 'congestion') actions.push('Assess for shock: HR, pulse quality, lactate, blood pressure.');
	if (!actions.length) actions.push('No action required — record as a normal baseline for this patient.');

	return {
		L, a, b, chroma, hue,
		classKey: best,
		classLabel: cls.label,
		classDesc: cls.desc,
		tone: override,
		scores,
		crtSeconds,
		crtTone,
		crtVerdict,
		actions,
		deltaEToNormal: Math.hypot(L - 62, a - 30, b - 16)
	};
}

/* =========================================================================
 * 5. QUOTE AUDITOR
 * ========================================================================= */
export const REGIONS = [
	{ key: 'us_midwest', label: 'United States · Midwest', index: 1.0 },
	{ key: 'us_coastal', label: 'United States · Coastal metro', index: 1.38 },
	{ key: 'uk', label: 'United Kingdom', index: 1.22 },
	{ key: 'eu', label: 'European Union', index: 1.14 },
	{ key: 'kenya', label: 'Kenya · Nairobi', index: 0.42 },
	{ key: 'south_africa', label: 'South Africa', index: 0.56 },
	{ key: 'australia', label: 'Australia / NZ', index: 1.27 },
	{ key: 'india', label: 'India', index: 0.34 }
];

export const PROCEDURES = [
	{
		key: 'spay',
		label: 'Canine ovariohysterectomy (spay)',
		code: 'VET-SP-042',
		fairLow: 380,
		fairHigh: 950,
		durationMin: 60,
		includes: ['General anaesthesia', 'IV catheter + fluids', 'Pain management', 'Anaesthetic monitoring', 'Take-home analgesia'],
		watchFor: ['Separate "anaesthesia" line on top of a bundled surgical fee', 'Unbundled "monitoring" charges', 'Dental cleaning added without consent']
	},
	{
		key: 'dental',
		label: 'Dental scaling + full-mouth radiographs',
		code: 'VET-DN-118',
		fairLow: 320,
		fairHigh: 880,
		durationMin: 75,
		includes: ['Anaesthesia', 'Full-mouth intra-oral radiographs', 'Scaling & polishing', 'Extraction allowance'],
		watchFor: ['Per-tooth extraction add-ons quoted as a lump sum', 'Radiographs billed separately per tooth', 'Anaesthetic re-check fee on the day']
	},
	{
		key: 'mass',
		label: 'Mass removal + histopathology',
		code: 'VET-SX-207',
		fairLow: 340,
		fairHigh: 1250,
		durationMin: 55,
		includes: ['Surgical excision', 'Histopathology (1 site)', 'Suture removal', 'Post-op check'],
		watchFor: ['"Lab handling" markup exceeding 30 % of the histopathology fee', 'Re-suture removal fee', 'Consumables surcharge > 10 %']
	},
	{
		key: 'vaccines',
		label: 'Core vaccine bundle (DHPP/FVRCP + rabies)',
		code: 'VET-VX-011',
		fairLow: 65,
		fairHigh: 210,
		durationMin: 20,
		includes: ['Physical examination', 'Core vaccines', 'Rabies certificate', 'Vaccine card'],
		watchFor: ['Exam fee charged twice (once per vaccine)', 'Mandatory "wellness panel" upsell', 'Certificate administration fee']
	},
	{
		key: 'tplo',
		label: 'TPLO — cranial cruciate ligament surgery',
		code: 'VET-OR-330',
		fairLow: 2900,
		fairHigh: 5800,
		durationMin: 150,
		includes: ['Pre-op radiographs', 'TPLO implant & surgery', '2 nights hospitalisation', 'Rehab programme (4 sessions)'],
		watchFor: ['Implant billed as a separate retail item', 'Post-op radiograph surcharge', 'Rehab sessions repriced above quote']
	},
	{
		key: 'foreign_body',
		label: 'Emergency foreign-body surgery',
		code: 'VET-EM-404',
		fairLow: 1800,
		fairHigh: 4600,
		durationMin: 120,
		includes: ['Emergency triage', 'Anaesthesia', 'Enterotomy/gastrotomy', '24 h hospitalisation'],
		watchFor: ['Emergency surcharge above 35 %', 'Per-hour ICU monitoring billed hourly', 'Fluid bag markup > 40 %']
	}
];

export function getProcedure(key) {
	return PROCEDURES.find((p) => p.key === key) || PROCEDURES[0];
}

export function getRegion(key) {
	return REGIONS.find((r) => r.key === key) || REGIONS[0];
}

function normaliseLabel(s) {
	return s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Parse "description: 120" or "description 120" lines into line items. */
export function parseLineItems(text = '') {
	return text
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const m = line.match(/^(.*?)[\s:–-]+([0-9]+(?:\.[0-9]+)?)$/);
			if (!m) return { desc: line, amount: 0, parsed: false };
			return { desc: m[1].trim(), amount: Number(m[2]), parsed: true };
		});
}

/**
 * Audit a veterinary quote.
 * @param {{
 *   procedureKey:string, quotedTotal:number, regionKey:string,
 *   lineItems:Array<{desc:string,amount:number}>, emergency?:boolean,
 *   insurance?:{coveragePct:number, deductible:number, annualUsed:number, allowedFactor:number}
 * }} input
 */
export function auditQuote({
	procedureKey = 'spay',
	quotedTotal = 0,
	regionKey = 'us_midwest',
	lineItems = [],
	emergency = false,
	insurance = { coveragePct: 80, deductible: 250, annualUsed: 0, allowedFactor: 0.85 }
} = {}) {
	const proc = getProcedure(procedureKey);
	const region = getRegion(regionKey);
	const fairLow = proc.fairLow * region.index;
	const fairHigh = proc.fairHigh * region.index;
	const total = Math.max(0, Number(quotedTotal) || 0);
	const mid = (fairLow + fairHigh) / 2;
	const overMidPct = mid > 0 ? ((total - mid) / mid) * 100 : 0;
	const vsHighPct = fairHigh > 0 ? ((total - fairHigh) / fairHigh) * 100 : 0;

	const flags = [];

	// Duplicate detection
	const seen = new Map();
	for (const item of lineItems) {
		if (!item.amount) continue;
		const key = normaliseLabel(item.desc);
		seen.set(key, (seen.get(key) || 0) + 1);
	}
	for (const [desc, count] of seen) {
		if (count > 1) flags.push({ key: 'duplicate', severity: 'bad', title: `Duplicate line item ×${count}`, detail: `“${desc}” appears ${count} times. Ask the clinic to consolidate.` });
	}

	// Unbundling detection
	const BUNDLED = ['anesthesia', 'anaesthesia', 'monitoring', 'iv catheter', 'intravenous catheter', 'fluids', 'pain management', 'analgesia', 'suture removal'];
	for (const item of lineItems) {
		const n = normaliseLabel(item.desc);
		if (BUNDLED.some((b) => n.includes(b)) && item.amount > 0) {
			flags.push({
				key: 'unbundling',
				severity: 'warn',
				title: 'Possible unbundling',
				detail: `“${item.desc}” (${item.amount}) is normally included in the ${proc.label} fee. Verify whether this is a duplicate charge.`
			});
		}
	}

	// Pharmacy / consumable markup
	for (const item of lineItems) {
		const n = normaliseLabel(item.desc);
		if ((n.includes('medication') || n.includes('pharmacy') || n.includes('drug')) && item.amount > 0 && item.amount > proc.fairLow * 0.35) {
			flags.push({
				key: 'markup',
				severity: 'warn',
				title: 'Pharmacy markup above typical',
				detail: `“${item.desc}” at ${item.amount} is above 35 % of the base procedure cost — request an itemised drug list with unit prices.`
			});
		}
	}

	// Emergency surcharge
	if (emergency && total > fairHigh * 1.4) {
		flags.push({
			key: 'emergency',
			severity: 'warn',
			title: 'Emergency surcharge above 40 %',
			detail: 'Out-of-hours surcharges are legitimate but should be itemised separately from the procedure fee.'
		});
	}

	if (total > fairHigh * 1.25) {
		flags.push({
			key: 'overcharge',
			severity: 'bad',
			title: `Quoted ${vsHighPct.toFixed(0)} % above the regional fair ceiling`,
			detail: `Fair ceiling for this region is ${fairHigh.toFixed(0)}. Request a written itemisation and consider a second opinion.`
		});
	} else if (total > fairHigh) {
		flags.push({
			key: 'elevated',
			severity: 'warn',
			title: 'Above the typical range',
			detail: `Quote exceeds the ${fairHigh.toFixed(0)} ceiling by ${vsHighPct.toFixed(0)} % — within the range of legitimate complexity variation, but worth clarifying.`
		});
	} else if (total > 0 && total < fairLow * 0.65) {
		flags.push({
			key: 'lowball',
			severity: 'warn',
			title: 'Suspiciously low quote',
			detail: 'Prices far below the regional floor often exclude anaesthesia, monitoring, histopathology or post-op care. Confirm what is included in writing.'
		});
	}

	if (!flags.length) {
		flags.push({ key: 'clean', severity: 'ok', title: 'No billing red flags', detail: 'Quote falls inside the regional fair range with no duplicate or unbundled items.' });
	}

	let verdict = 'Fair market price';
	let tone = 'ok';
	if (total > fairHigh * 1.25) { verdict = 'Overcharge flagged'; tone = 'bad'; }
	else if (total > fairHigh) { verdict = 'Elevated — clarify inclusions'; tone = 'warn'; }
	else if (total > 0 && total < fairLow * 0.65) { verdict = 'Below floor — verify inclusions'; tone = 'warn'; }
	else if (total >= fairLow && total <= fairHigh) { verdict = 'Fair market price'; tone = 'ok'; }
	else if (total > 0) { verdict = 'Slightly below regional range'; tone = 'info'; }

	// Insurance maths
	const allowed = total * (insurance.allowedFactor ?? 0.85);
	const afterDeductible = Math.max(0, allowed - Math.max(0, insurance.deductible ?? 0));
	const grossReimbursement = afterDeductible * ((insurance.coveragePct ?? 80) / 100);
	const remainingCap = Math.max(0, 10000 - (insurance.annualUsed ?? 0));
	const reimbursement = Math.min(grossReimbursement, remainingCap);
	const outOfPocket = Math.max(0, total - reimbursement);

	return {
		procedure: proc,
		region,
		total,
		fairLow,
		fairHigh,
		mid,
		overMidPct,
		vsHighPct,
		verdict,
		tone,
		flags,
		includes: proc.includes,
		watchFor: proc.watchFor,
		insurance: {
			...insurance,
			allowed,
			reimbursement,
			outOfPocket,
			remainingCap,
			coverageAppliedPct: total > 0 ? (reimbursement / total) * 100 : 0
		}
	};
}

/* =========================================================================
 * 6. CONVENIENCE SNAPSHOT FOR THE VAULT
 * ========================================================================= */
export function buildTickRecord({ speciesKey, lengthMm, widthMm, patient, notes = '' }) {
	const si = scutalIndex(lengthMm, widthMm);
	const { hours, method } = attachmentHoursFromSI(si, speciesKey);
	const risk = transmissionRisk({ hours, speciesKey, si });
	return {
		modelVersion: MODEL_VERSION,
		speciesKey,
		species: getTickSpecies(speciesKey).label,
		lengthMm,
		widthMm,
		si,
		hours,
		method,
		risk,
		patient,
		notes,
		timestamp: new Date().toISOString()
	};
}
