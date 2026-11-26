/**
 * VET-SPECTRA · vetToxicologyAllometryEngine.js
 * ---------------------------------------------------------------------------
 * Pure ES2024. Zero dependencies. 100% deterministic — mirrors
 * python_vet/toxicology_allometry_solver.py so the workstation behaves
 * identically on Vercel (Python 3.12 serverless) and offline inside the APK.
 *
 * Contents
 *  1. Methylxanthine (theobromine + caffeine) dry-matter matrix constants.
 *  2. Species-specific 1-compartment Bateman PK parameters + enterohepatic
 *     recirculation term for canine theobromine.
 *  3. Multi-toxin veterinary emergency matrix (xylitol, Allium, Vitis,
 *     NSAIDs/paracetamol, true lilies, permethrin, ADHD/decongestants, zinc,
 *     rodenticide anticoagulants, sago cycad) with exact mg/kg / g/kg maths.
 *  4. Gastric-emptying decontamination countdown (apomorphine / charcoal).
 *  5. Kleiber allometric RER (70·W^0.75), MER by life stage, and 24 h fluid
 *     therapy plan (deficit + maintenance + ongoing losses).
 *  6. MDR1 (ABCB1-1Δ) herding-breed pharmacogenomic warning.
 *  7. Four one-tap clinical case presets.
 * ---------------------------------------------------------------------------
 */

export const MODEL_VERSION = 'vet-spectra/pk-27.0.0';

/* =========================================================================
 * 1. CHOCOLATE & CAFFEINE DRY-MATTER ALKALOID MATRIX (mg per gram)
 * ========================================================================= */
export const CHOCOLATE_MATRICES = [
	{
		key: 'white',
		label: 'White Chocolate',
		theo: 0.009,
		caff: 0.003,
		cacao: 0.0,
		note: 'Cocoa butter only — alkaloid content essentially nil, but fat load causes pancreatitis/vomiting.'
	},
	{
		key: 'milk',
		label: 'Milk Chocolate',
		theo: 2.05,
		caff: 0.21,
		cacao: 0.3,
		note: 'Most common household ingestion. 100 g on a 10 kg dog ≈ 22.6 mg/kg total.'
	},
	{
		key: 'semisweet',
		label: 'Semi-Sweet Dark (55% cacao)',
		theo: 4.59,
		caff: 0.6,
		cacao: 0.55,
		note: 'Chocolate chips / baking chunks. Two cups of chips can reach cardiotoxic range in a small dog.'
	},
	{
		key: 'dark70',
		label: 'Dark Chocolate (70–72% cacao)',
		theo: 6.8,
		caff: 0.8,
		cacao: 0.71,
		note: 'Reference matrix for the classic “85 g of 70% dark” emergency call.'
	},
	{
		key: 'extradark',
		label: 'Extra-Dark Chocolate (85% cacao)',
		theo: 8.85,
		caff: 1.05,
		cacao: 0.85,
		note: 'Craft/artisan bars. 40 g is neurotoxic territory for a 5 kg cat-sized patient.'
	},
	{
		key: 'bakers',
		label: "Unsweetened Baker's Chocolate",
		theo: 14.1,
		caff: 1.5,
		cacao: 1.0,
		note: 'Highest-risk bar chocolate. A single 28 g square = 15.6 mg/kg in a 25 kg dog.'
	},
	{
		key: 'cocoa',
		label: 'Dry Unsweetened Cocoa Powder',
		theo: 26.0,
		caff: 2.3,
		cacao: 1.0,
		note: 'Extreme potency — 10 g (one heaped tablespoon) can be lethal to a toy breed.'
	},
	{
		key: 'espresso',
		label: 'Espresso / Roasted Coffee Grounds',
		theo: 0.0,
		caff: 12.5,
		cacao: 0.0,
		note: 'Caffeine-dominant. Used grounds are especially dangerous to curious puppies.'
	},
	{
		key: 'mulch',
		label: 'Cocoa Bean Hull Garden Mulch',
		theo: 18.2,
		caff: 1.6,
		cacao: 0.9,
		note: 'Garden-centre cocoa mulch — dogs are attracted by the sweet chocolate aroma.'
	}
];

export function getMatrix(key) {
	return CHOCOLATE_MATRICES.find((m) => m.key === key) || CHOCOLATE_MATRICES[3];
}

/* =========================================================================
 * 2. SPECIES PK PARAMETERS
 * ========================================================================= */
export const PK_PARAMETERS = {
	dog: {
		label: 'Canine (Dog)',
		theo: {
			t12: 17.5,
			ke: Math.LN2 / 17.5,
			ka: 0.35,
			vd: 0.68,
			f: 0.77,
			recircFraction: 0.19,
			recircLagHr: 5.4,
			recircKa: 0.22
		},
		caff: { t12: 4.5, ke: Math.LN2 / 4.5, ka: 1.4, vd: 0.7, f: 1.0 }
	},
	cat: {
		label: 'Feline (Cat)',
		theo: {
			t12: 25.5,
			ke: Math.LN2 / 25.5,
			ka: 0.3,
			vd: 0.62,
			f: 0.72,
			recircFraction: 0.23,
			recircLagHr: 6.1,
			recircKa: 0.2
		},
		caff: { t12: 6.2, ke: Math.LN2 / 6.2, ka: 1.2, vd: 0.75, f: 0.95 }
	}
};

/** Single dose, first-order absorption -> elimination (Bateman) term. */
export function bateman(tHr, doseMgKg, ka, ke, vd, lagHr = 0, f = 1) {
	const t = tHr - lagHr;
	if (t <= 0) return 0;
	if (Math.abs(ka - ke) < 1e-9) return (f * doseMgKg * ka * t * Math.exp(-ke * t)) / vd;
	return ((f * doseMgKg * ka) / (vd * (ka - ke))) * (Math.exp(-ke * t) - Math.exp(-ka * t));
}

/**
 * Combined plasma concentration (mg/L) at time t for theobromine + caffeine,
 * including the canine/feline enterohepatic recirculation second-absorption
 * term for theobromine (biliary reabsorption of theobromine is well described
 * in dogs and materially extends the terminal phase).
 */
export function plasmaConcentration(tHr, { doseTheoMgKg, doseCaffMgKg, species = 'dog', recirculation = true }) {
	const p = PK_PARAMETERS[species] || PK_PARAMETERS.dog;
	const theo =
		bateman(tHr, doseTheoMgKg, p.theo.ka, p.theo.ke, p.theo.vd, 0, p.theo.f) +
		(recirculation
			? bateman(
					tHr,
					doseTheoMgKg * p.theo.recircFraction,
					p.theo.recircKa,
					p.theo.ke,
					p.theo.vd,
					p.theo.recircLagHr,
					p.theo.f
			  )
			: 0);
	const caff = bateman(tHr, doseCaffMgKg, p.caff.ka, p.caff.ke, p.caff.vd, 0, p.caff.f);
	return { theo: Math.max(0, theo), caff: Math.max(0, caff), total: Math.max(0, theo) + Math.max(0, caff) };
}

/* =========================================================================
 * 3. METHYLXANTHINE TOXICITY ZONES (total theobromine + caffeine mg/kg)
 * ========================================================================= */
export const METHYLXANTHINE_ZONES = [
	{ key: 'subclinical', label: 'Sub-Clinical', max: 20, tone: 'ok', action: 'Monitor at home. Offer water; watch for 6 h for vomiting or hyperactivity.' },
	{ key: 'gi', label: 'GI Distress', max: 40, tone: 'warn', action: 'Expect vomiting/diarrhoea and polydipsia. Call your veterinarian for an anti-emetic plan.' },
	{ key: 'cardio', label: 'Cardiotoxic Arrhythmia', max: 60, tone: 'bad', action: 'Veterinary emergency. ECG monitoring, IV fluids, beta-blockade may be required.' },
	{ key: 'neuro', label: 'Neurotoxic Seizures', max: 100, tone: 'bad', action: 'Immediate hospitalisation. Seizure control (diazepam/midazolam) and thermoregulation.' },
	{ key: 'ld50', label: '≥ LD50 Critical', max: Infinity, tone: 'bad', action: 'LD50 range — resuscitative support, ICU admission, continuous ECG.' }
];

export function classifyMethylxanthine(totalMgKg) {
	if (!isFinite(totalMgKg) || totalMgKg <= 0) return METHYLXANTHINE_ZONES[0];
	for (const z of METHYLXANTHINE_ZONES) if (totalMgKg < z.max) return z;
	return METHYLXANTHINE_ZONES[METHYLXANTHINE_ZONES.length - 1];
}

export function doseFromMass({ massG, matrixKey, weightKg, species = 'dog' }) {
	const m = getMatrix(matrixKey);
	const w = Math.max(0.1, Number(weightKg) || 0.1);
	const g = Math.max(0, Number(massG) || 0);
	const theoMg = g * m.theo;
	const caffMg = g * m.caff;
	const doseTheoMgKg = theoMg / w;
	const doseCaffMgKg = caffMg / w;
	const total = doseTheoMgKg + doseCaffMgKg;
	return {
		species,
		matrix: m,
		massG: g,
		weightKg: w,
		theoMg,
		caffMg,
		doseTheoMgKg,
		doseCaffMgKg,
		doseTotalMgKg: total,
		zone: classifyMethylxanthine(total),
		totalTheoMg: theoMg,
		mgPerKgBreakdown: {
			theobromine: doseTheoMgKg,
			caffeine: doseCaffMgKg
		}
	};
}

/**
 * Build a 0–72 h plasma curve + per-hour toxicity classification.
 * Returns arrays sized `steps + 1` for direct canvas rendering.
 */
export function buildMethylxanthineCurve({
	massG = 85,
	matrixKey = 'dark70',
	weightKg = 12,
	species = 'dog',
	hours = 72,
	steps = 360
}) {
	const dose = doseFromMass({ massG, matrixKey, weightKg, species });
	const n = Math.max(8, Math.floor(steps));
	const dt = hours / n;
	const points = [];
	let peak = { t: 0, total: 0 };
	let tAboveCardio = 0;
	for (let i = 0; i <= n; i++) {
		const t = i * dt;
		const c = plasmaConcentration(t, {
			doseTheoMgKg: dose.doseTheoMgKg,
			doseCaffMgKg: dose.doseCaffMgKg,
			species
		});
		if (c.total > peak.total) peak = { t, total: c.total };
		// Approximation of circulating burden (mg/L) mapped back to dose-normalised
		// mg/kg equivalents for the shaded clinical zone bands.
		const equivMgKg = (c.total * (PK_PARAMETERS[species]?.theo.vd ?? 0.68));
		if (equivMgKg >= 40) tAboveCardio += dt;
		points.push({ t, theo: c.theo, caff: c.caff, total: c.total, equivMgKg });
	}
	return {
		dose,
		points,
		peak,
		hoursAboveCardiotoxic: tAboveCardio,
		maxTotal: Math.max(...points.map((p) => p.total), 0.0001)
	};
}

/* =========================================================================
 * 4. GASTRIC EMPTYING / DECONTAMINATION WINDOW
 * ========================================================================= */
/**
 * Residual unabsorbed gastric fraction:
 *   G(t) = 100 · e^(−(ln2 / t½,gastric) · Δt)
 */
export function gastricEmptyingFraction({ minutesSinceIngestion = 45, tHalfGastricHr = 2.0 } = {}) {
	const dtH = Math.max(0, minutesSinceIngestion) / 60;
	const k = Math.LN2 / Math.max(0.1, tHalfGastricHr);
	const frac = 100 * Math.exp(-k * dtH);
	const emesisEffective = frac >= 40;
	const charcoalEffective = frac >= 15;
	// Solve for time remaining until residual falls below each threshold.
	const minutesUntil = (pct) => Math.max(0, (-Math.log(pct / 100) / k - dtH) * 60);
	return {
		minutesSinceIngestion,
		tHalfGastricHr,
		residualPct: frac,
		emesisEffective,
		charcoalEffective,
		minutesUntilEmesisWindow: minutesUntil(40),
		minutesUntilCharcoalWindow: minutesUntil(15),
		charcoalDoseMgKg: [1000, 2000],
		recommendation: emesisEffective
			? 'Emesis (apomorphine 0.03 mg/kg IV/eye in dogs, dexmedetomidine 7–10 µg/kg IM in cats) is still clinically worthwhile — residual gastric load is high.'
			: charcoalEffective
			? 'Emesis window essentially closed. Activated charcoal 1–2 g/kg PO with a cathartic remains useful.'
			: 'Decontamination window closed — shift to supportive care, monitoring and toxin-specific antidotes.'
	};
}

/* =========================================================================
 * 5. MULTI-TOXIN EMERGENCY MATRIX
 * ========================================================================= */
const SEV = { none: 0, low: 1, moderate: 2, high: 3, critical: 4 };
export const SEVERITY_LABELS = ['No risk', 'Low', 'Moderate', 'High', 'Critical'];

function makeResult({ doseText, severity, headline, detail, actions = [], extra = {} }) {
	return {
		doseText,
		severity: typeof severity === 'string' ? SEV[severity] ?? 0 : severity,
		severityLabel: SEVERITY_LABELS[typeof severity === 'string' ? SEV[severity] ?? 0 : severity],
		headline,
		detail,
		actions,
		...extra
	};
}

/**
 * Toxin catalogue. `evaluate({ amount, weightKg, species, variant })`
 * receives raw user input and returns a full clinical verdict.
 * amount units are per-toxin (`unit` field).
 */
export const TOXIN_PROFILES = {
	xylitol: {
		key: 'xylitol',
		label: 'Xylitol (birch sugar)',
		unit: 'mg',
		defaultAmount: 1800,
		variants: [
			{ key: 'gum', label: 'Sugar-free gum (≈0.3 g xylitol/piece)', factor: 300 },
			{ key: 'peanut', label: '“Sugar-free” peanut butter (≈1 g/g)', factor: 1000 },
			{ key: 'bake', label: 'Xylitol baking sweetener', factor: 1000 },
			{ key: 'mint', label: 'Breath mints (≈0.15 g/mint)', factor: 150 }
		],
		notes: 'Dogs only: massive insulin release → hypoglycaemia within 15–60 min, then acute hepatic necrosis.',
		evaluate({ amount, weightKg, variant }) {
			const dose = Math.max(0, amount) / Math.max(0.1, weightKg);
			const v = TOXIN_PROFILES.xylitol.variants.find((x) => x.key === variant) || null;
			const actions = [
				'Check blood glucose every 30 min for the first 4 h (target 4.0–6.5 mmol/L).',
				'If hypoglycaemic: 1–2 mL/kg 25% dextrose IV slow, then CRI.',
				'≥ 500 mg/kg: baseline ALT/ALP/bilirubin, repeat at 24 h and 48 h for hepatic necrosis.'
			];
			if (dose >= 500)
				return makeResult({
					doseText: `${dose.toFixed(0)} mg/kg`,
					severity: 'critical',
					headline: 'Acute hepatic necrosis threshold exceeded',
					detail: '≥ 500 mg/kg xylitol produces fulminant hepatocellular necrosis in dogs. ICU admission, IV fluids, hepatoprotectants (SAMe, silymarin) and serial liver enzymes.',
					actions,
					extra: { variantLabel: v?.label }
				});
			if (dose >= 100)
				return makeResult({
					doseText: `${dose.toFixed(0)} mg/kg`,
					severity: 'high',
					headline: 'Hypoglycaemia threshold exceeded (≥ 100 mg/kg)',
					detail: 'Expect profound insulin-mediated hypoglycaemia within 15–60 min and possible seizures.',
					actions,
					extra: { variantLabel: v?.label }
				});
			if (dose > 0)
				return makeResult({
					doseText: `${dose.toFixed(0)} mg/kg`,
					severity: 'low',
					headline: 'Below canine hypoglycaemia threshold',
					detail: 'Doses under 100 mg/kg rarely cause hypoglycaemia, but GI upset and a small insulin surge are still possible.',
					actions: ['Monitor for 4–6 h. Offer a small carbohydrate meal.'],
					extra: { variantLabel: v?.label }
				});
			return makeResult({ doseText: '0 mg/kg', severity: 'none', headline: 'No exposure entered', detail: 'Enter the ingested mass to compute risk.', actions: [] });
		}
	},

	allium: {
		key: 'allium',
		label: 'Allium species (onion / garlic / leek / chives)',
		unit: 'g',
		defaultAmount: 80,
		variants: [
			{ key: 'onion_raw', label: 'Raw onion', potency: 1 },
			{ key: 'onion_cooked', label: 'Cooked onion', potency: 1.2 },
			{ key: 'garlic', label: 'Garlic (5× onion potency)', potency: 5 },
			{ key: 'leek', label: 'Leek / chives / scallion', potency: 0.6 },
			{ key: 'powder', label: 'Onion/garlic powder (4× fresh weight)', potency: 4 }
		],
		notes: 'N-propyl disulfide oxidises haemoglobin → Heinz bodies, eccentrocytes and haemolytic anaemia.',
		evaluate({ amount, weightKg, species, variant }) {
			const v = TOXIN_PROFILES.allium.variants.find((x) => x.key === variant) || TOXIN_PROFILES.allium.variants[0];
			const onionEqGkg = (Math.max(0, amount) * v.potency) / Math.max(0.1, weightKg);
			const threshold = species === 'cat' ? 1.0 : 5.0;
			const pct = (onionEqGkg / threshold) * 100;
			const actions = [
				'Repeat PCV/TPC at 24 h, 72 h and 7 days — Heinz-body anaemia peaks at 3–5 days.',
				'No emesis if >2 h post-ingestion; activated charcoal 1–2 g/kg if recent.',
				'Blood transfusion if PCV < 15–18 % or clinical collapse.'
			];
			if (onionEqGkg >= threshold * 2)
				return makeResult({
					doseText: `${onionEqGkg.toFixed(2)} g/kg onion-equivalent`,
					severity: 'critical',
					headline: 'Marked haemolytic dose',
					detail: `${pct.toFixed(0)} % of the ${threshold} g/kg ${species === 'cat' ? 'feline' : 'canine'} threshold — expect significant Heinz-body haemolytic anaemia at day 3–5.`,
					actions,
					extra: { onionEqGkg, threshold, variantLabel: v.label }
				});
			if (onionEqGkg >= threshold)
				return makeResult({
					doseText: `${onionEqGkg.toFixed(2)} g/kg onion-equivalent`,
					severity: 'high',
					headline: 'Above haemolysis threshold',
					detail: `Exceeds the ${threshold} g/kg ${species === 'cat' ? 'feline (8 reactive haemoglobin sulfhydryls)' : 'canine'} threshold.`,
					actions,
					extra: { onionEqGkg, threshold, variantLabel: v.label }
				});
			if (onionEqGkg >= threshold * 0.5)
				return makeResult({
					doseText: `${onionEqGkg.toFixed(2)} g/kg onion-equivalent`,
					severity: 'moderate',
					headline: 'Sub-threshold but clinically relevant',
					detail: 'Repeated small exposures accumulate. Cats are exquisitely sensitive — treat any feline allium exposure seriously.',
					actions,
					extra: { onionEqGkg, threshold, variantLabel: v.label }
				});
			return makeResult({
				doseText: `${onionEqGkg.toFixed(2)} g/kg onion-equivalent`,
				severity: onionEqGkg > 0 ? 'low' : 'none',
				headline: 'Below haemolysis threshold',
				detail: 'Monitor for GI signs; avoid further allium exposure.',
				actions: ['Withhold further allium. Re-check PCV if any pale gums appear.'],
				extra: { onionEqGkg, threshold, variantLabel: v.label }
			});
		}
	},

	grape: {
		key: 'grape',
		label: 'Vitis vinifera (grapes / raisins / currants)',
		unit: 'g',
		defaultAmount: 30,
		variants: [
			{ key: 'grape', label: 'Fresh grapes', thresholdGKg: 19.6 },
			{ key: 'raisin', label: 'Raisins / sultanas / currants', thresholdGKg: 2.8 },
			{ key: 'juice', label: 'Grape juice', thresholdGKg: 8.0 }
		],
		notes: 'Tartaric acid nephrotoxicity → acute proximal tubular necrosis; anuria within 24–72 h.',
		evaluate({ amount, weightKg, variant }) {
			const v = TOXIN_PROFILES.grape.variants.find((x) => x.key === variant) || TOXIN_PROFILES.grape.variants[0];
			const gkg = Math.max(0, amount) / Math.max(0.1, weightKg);
			const actions = [
				'Induce emesis if <2 h; activated charcoal 1–2 g/kg.',
				'Start IV crystalloids at 2× maintenance for 48 h to maintain urine output ≥ 2 mL/kg/h.',
				'Baseline and 24/48/72 h creatinine, BUN, phosphate, urine specific gravity.'
			];
			if (gkg >= v.thresholdGKg)
				return makeResult({
					doseText: `${gkg.toFixed(2)} g/kg`,
					severity: 'critical',
					headline: 'Nephrotoxic threshold exceeded',
					detail: `≥ ${v.thresholdGKg} g/kg ${v.label.toLowerCase()} — acute renal failure risk. There is no antidote; aggressive diuresis is the treatment.`,
					actions,
					extra: { gkg, thresholdGKg: v.thresholdGKg }
				});
			if (gkg >= v.thresholdGKg * 0.4)
				return makeResult({
					doseText: `${gkg.toFixed(2)} g/kg`,
					severity: 'moderate',
					headline: 'Idiosyncratic risk zone',
					detail: 'Grape toxicosis is idiosyncratic — some dogs develop renal injury well below the published threshold.',
					actions,
					extra: { gkg, thresholdGKg: v.thresholdGKg }
				});
			return makeResult({
				doseText: `${gkg.toFixed(2)} g/kg`,
				severity: gkg > 0 ? 'low' : 'none',
				headline: 'Low-dose exposure',
				detail: 'Monitor thirst, urination and vomiting for 24 h.',
				actions: ['Encourage water intake; recheck renal panel if any vomiting occurs.'],
				extra: { gkg, thresholdGKg: v.thresholdGKg }
			});
		}
	},

	nsaid: {
		key: 'nsaid',
		label: 'Human NSAIDs & analgesics',
		unit: 'mg',
		defaultAmount: 400,
		variants: [
			{ key: 'ibuprofen', label: 'Ibuprofen', tiers: [[25, 'GI ulceration'], [100, 'Acute renal failure'], [400, 'CNS seizures / coma']] },
			{ key: 'naproxen', label: 'Naproxen', tiers: [[5, 'GI ulceration'], [10, 'Renal & CNS risk']] },
			{ key: 'acetaminophen_dog', label: 'Paracetamol (dog)', tiers: [[75, 'Hepatic necrosis / Heinz bodies'], [150, 'Methaemoglobinaemia']] },
			{ key: 'acetaminophen_cat', label: 'Paracetamol (cat)', tiers: [[10, 'Methaemoglobinaemia emergency']] },
			{ key: 'aspirin', label: 'Aspirin', tiers: [[25, 'GI irritation'], [50, 'GI ulceration']] }
		],
		notes: 'Cats lack UGT1A6 glucuronidation (pseudogene) — paracetamol is uniformly lethal without rapid NAC + methylene blue.',
		evaluate({ amount, weightKg, variant, species }) {
			let v = TOXIN_PROFILES.nsaid.variants.find((x) => x.key === variant);
			if (!v) v = TOXIN_PROFILES.nsaid.variants[0];
			const mgkg = Math.max(0, amount) / Math.max(0.1, weightKg);
			let hit = null;
			let nextIdx = 0;
			for (let i = 0; i < v.tiers.length; i++) {
				if (mgkg >= v.tiers[i][0]) {
					hit = v.tiers[i];
					nextIdx = i + 1;
				}
			}
			const actions = [
				'Decontaminate (emesis <2 h, charcoal 1–2 g/kg).',
				'GI protectant (misoprostol 2–5 µg/kg q8h) for ulceration risk.',
				'Monitor renal panel at 24 h; urine output ≥ 1–2 mL/kg/h.'
			];
			if (v.key.startsWith('acetaminophen') && species === 'cat') {
				actions.unshift('N-acetylcysteine 140 mg/kg IV then 70 mg/kg q6h × 5; methylene blue 1.5 mg/kg IV for methaemoglobinaemia.');
			}
			if (hit) {
				const sev = nextIdx >= v.tiers.length ? 'critical' : nextIdx >= 2 ? 'high' : 'moderate';
				return makeResult({
					doseText: `${mgkg.toFixed(1)} mg/kg`,
					severity: sev,
					headline: hit[1],
					detail: `${v.label} at ${mgkg.toFixed(1)} mg/kg crosses the ${hit[0]} mg/kg ${hit[1].toLowerCase()} threshold.`,
					actions,
					extra: { tiers: v.tiers, mgkg, variantLabel: v.label }
				});
			}
			return makeResult({
				doseText: `${mgkg.toFixed(1)} mg/kg`,
				severity: mgkg > 0 ? 'low' : 'none',
				headline: 'Below published toxic thresholds',
				detail: 'Still monitor for vomiting, melaena and abdominal pain for 24 h — NSAID toxicity is dose- and patient-dependent.',
				actions,
				extra: { tiers: v.tiers, mgkg, variantLabel: v.label }
			});
		}
	},

	lily: {
		key: 'lily',
		label: 'True lily (Lilium / Hemerocallis)',
		unit: 'g',
		defaultAmount: 1,
		variants: [
			{ key: 'pollen', label: 'Pollen' },
			{ key: 'petal', label: 'Petal / leaf' },
			{ key: 'vase', label: 'Vase water' },
			{ key: 'stamen', label: 'Stamen / stigmatic fluid' }
		],
		notes: 'Cats: any exposure to pollen, petals, leaves or vase water → acute oliguric renal failure within 18 h. Dogs: GI upset only.',
		evaluate({ amount, species, variant }) {
			const v = TOXIN_PROFILES.lily.variants.find((x) => x.key === variant);
			if (species === 'cat')
				return makeResult({
					doseText: 'Zero-margin exposure',
					severity: 'critical',
					headline: 'Feline true-lily emergency',
					detail: `Exposure to lily ${v?.label.toLowerCase() || 'material'} is a zero-margin nephrotoxic emergency. Oliguric/anuric renal failure develops within 18 h — prognosis is excellent if decontamination starts within 6 h and guarded after 18 h.`,
					actions: [
						'Immediate emesis + activated charcoal if <2 h.',
						'Start 48 h of IV crystalloids at 2–3× maintenance WITHOUT added potassium.',
						'Baseline creatinine, urine output; recheck q12–24 h for 3 days.'
					],
					extra: { variantLabel: v?.label }
				});
			return makeResult({
				doseText: `${(amount || 0).toFixed(1)} g`,
				severity: 'low',
				headline: 'Canine exposure — GI irritant only',
				detail: 'Dogs do not develop lily nephrotoxicity, but vomiting and hypersalivation are common. Remove all lilies from cat-accessible homes.',
				actions: ['Withhold food 2 h, offer water. Remove plant material from the house.'],
				extra: { variantLabel: v?.label }
			});
		}
	},

	permethrin: {
		key: 'permethrin',
		label: 'Permethrin / pyrethroid spot-on',
		unit: 'mg',
		defaultAmount: 400,
		variants: [
			{ key: 'dog_spot', label: 'Canine spot-on (45–65 %)', conc: 0.55 },
			{ key: 'cat_contact', label: 'Cat contact with dog product', conc: 0.55 },
			{ key: 'spray', label: 'Household spray (0.5 %)', conc: 0.005 }
		],
		notes: 'Cats lack hepatic glucuronidation of pyrethroids — tremor, hyperthermia and seizures within 2–6 h.',
		evaluate({ amount, species, variant }) {
			const v = TOXIN_PROFILES.permethrin.variants.find((x) => x.key === variant) || TOXIN_PROFILES.permethrin.variants[0];
			if (species === 'cat' && v.conc >= 0.4)
				return makeResult({
					doseText: 'Zero-margin feline exposure',
					severity: 'critical',
					headline: 'Feline pyrethroid emergency',
					detail: 'Concentrated canine permethrin products on (or near) a cat cause life-threatening tremors and seizures. Bathing in lukewarm water with liquid dish soap to remove residue is the critical first step.',
					actions: [
						'Bathe with warm water + mild detergent immediately (do NOT use cold water — worsens tremors).',
						'Methocarbamol 55–220 mg/kg IV to effect for tremor control; diazepam as adjunct.',
						'Active cooling if T > 40 °C; monitor for 24–48 h.'
					],
					extra: { variantLabel: v.label }
				});
			return makeResult({
				doseText: 'Permethrin exposure logged',
				severity: 'moderate',
				headline: 'Canine pyrethroid exposure',
				detail: 'Dogs tolerate permethrin well at label doses; overdose causes transient hyperaesthesia and drooling.',
				actions: ['Bathe to remove product, monitor for 12 h.'],
				extra: { variantLabel: v.label }
			});
		}
	},

	zinc: {
		key: 'zinc',
		label: 'Zinc (pennies, nuts, batteries)',
		unit: 'mg',
		defaultAmount: 600,
		variants: [
			{ key: 'penny', label: 'Post-1982 US penny (≈2 440 mg Zn)', per: 2440 },
			{ key: 'nut', label: 'Zinc nut / bolt (≈1 500 mg Zn)', per: 1500 },
			{ key: 'supplement', label: 'Zinc supplement tablet (≈50 mg)', per: 50 }
		],
		notes: 'Zinc toxicosis → intravascular haemolysis, Heinz bodies, pancreatitis, acute renal injury.',
		evaluate({ amount, weightKg, variant }) {
			const v = TOXIN_PROFILES.zinc.variants.find((x) => x.key === variant);
			const mgkg = (Math.max(0, amount) * (v?.per || 1)) / Math.max(0.1, weightKg);
			if (mgkg >= 100)
				return makeResult({
					doseText: `${mgkg.toFixed(0)} mg/kg zinc`,
					severity: 'critical',
					headline: 'Severe zinc toxicosis',
					detail: '≥ 100 mg/kg elemental zinc causes haemolysis and multi-organ injury. Surgical/endoscopic removal of the metal object is usually required.',
					actions: ['Imaging to locate the object.', 'IV fluids, anti-emetics, PCV/TPC q12h.', 'Consider endoscopy/surgery for gastric foreign body.'],
					extra: { variantLabel: v?.label }
				});
			return makeResult({
				doseText: `${mgkg.toFixed(0)} mg/kg zinc`,
				severity: mgkg > 0 ? 'moderate' : 'none',
				headline: 'Zinc exposure below severe threshold',
				detail: 'Monitor for vomiting and haemolysis; single small ingestions often pass.',
				actions: ['Feed a small meal to buffer the stomach; monitor PCV.'],
				extra: { variantLabel: v?.label }
			});
		}
	},

	rodenticide: {
		key: 'rodenticide',
		label: 'Anticoagulant rodenticide',
		unit: 'g',
		defaultAmount: 30,
		variants: [
			{ key: 'brodifacoum', label: 'Brodifacoum (2nd gen, 0.005 %)', conc: 0.00005, halfLife: 120 },
			{ key: 'bromadiolone', label: 'Bromadiolone (2nd gen, 0.005 %)', conc: 0.00005, halfLife: 60 },
			{ key: 'warfarin', label: 'Warfarin (1st gen, 0.025 %)', conc: 0.00025, halfLife: 15 },
			{ key: 'diphacinone', label: 'Diphacinone (0.005 %)', conc: 0.00005, halfLife: 45 }
		],
		notes: 'Vitamin K1 (phytomenadione) antagonist — bleeding begins 3–7 days after 2nd-generation exposure.',
		evaluate({ amount, weightKg, variant }) {
			const v = TOXIN_PROFILES.rodenticide.variants.find((x) => x.key === variant) || TOXIN_PROFILES.rodenticide.variants[0];
			const activeMg = Math.max(0, amount) * v.conc * 1000;
			const mgkg = activeMg / Math.max(0.1, weightKg);
			const toxicDose = v.key === 'warfarin' ? 5 : 0.1;
			if (mgkg >= toxicDose)
				return makeResult({
					doseText: `${mgkg.toFixed(3)} mg/kg active`,
					severity: 'critical',
					headline: 'Anticoagulant toxic dose',
					detail: `Exceeds the ${toxicDose} mg/kg threshold for ${v.label}. Coagulopathy appears in 3–7 days; PT/PTT should be checked at 48 h and 72 h.`,
					actions: [
						'Vitamin K1 2.5–5 mg/kg PO divided BID for 4–6 weeks (2nd generation).',
						'Baseline PT/PTT now, repeat at 48–72 h.',
						'Plasma transfusion if active bleeding and PT > 2× normal.'
					],
					extra: { activeMg, mgkg, variantLabel: v.label }
				});
			return makeResult({
				doseText: `${mgkg.toFixed(3)} mg/kg active`,
				severity: mgkg > 0 ? 'moderate' : 'none',
				headline: 'Sub-toxic but monitor',
				detail: 'Single low-dose ingestions may be managed with observation + PT at 48 h.',
				actions: ['PT/PTT at 48 h. Vitamin K1 if prolonged.'],
				extra: { activeMg, mgkg, variantLabel: v.label }
			});
		}
	},

	antifreeze: {
		key: 'antifreeze',
		label: 'Ethylene glycol (antifreeze)',
		unit: 'mL',
		defaultAmount: 30,
		variants: [
			{ key: 'antifreeze', label: 'Concentrated antifreeze (95 %)', density: 1.11, pct: 0.95 },
			{ key: 'rv', label: 'RV / marine antifreeze (50 %)', density: 1.05, pct: 0.5 }
		],
		notes: 'Metabolised by alcohol dehydrogenase to glyoxylic acid → oxalate crystals in renal tubules. Antidote window < 8–12 h.',
		evaluate({ amount, weightKg, variant }) {
			const v = TOXIN_PROFILES.antifreeze.variants.find((x) => x.key === variant) || TOXIN_PROFILES.antifreeze.variants[0];
			const mlkg = Math.max(0, amount) / Math.max(0.1, weightKg);
			const lethal = 1.4; // mL/kg of 95 % EG ~ LD50 in dogs
			if (mlkg >= lethal * 0.5)
				return makeResult({
					doseText: `${mlkg.toFixed(2)} mL/kg`,
					severity: 'critical',
					headline: 'Ethylene glycol emergency',
					detail: `${mlkg.toFixed(2)} mL/kg approaches the ${lethal} mL/kg LD50. 4-methylpyrazole (fomepizole) or ethanol therapy must start within hours.`,
					actions: [
						'Fomepizole 20 mg/kg IV (dogs) or ethanol CRI if unavailable.',
						'IV fluids 3× maintenance; monitor urine output.',
						'Baseline ethylene glycol test, BUN/creatinine, calcium, acid-base.'
					],
					extra: { mlkg, variantLabel: v.label }
				});
			return makeResult({
				doseText: `${mlkg.toFixed(2)} mL/kg`,
				severity: mlkg > 0 ? 'moderate' : 'none',
				headline: 'Sub-lethal ethylene glycol exposure',
				detail: 'Any ethylene glycol exposure warrants veterinary assessment — the antidote is time-critical.',
				actions: ['Call your veterinarian or poison control now.'],
				extra: { mlkg, variantLabel: v.label }
			});
		}
	}
};

export const TOXIN_KEYS = Object.keys(TOXIN_PROFILES);

export function evaluateToxin({ toxinKey, amount, weightKg, species = 'dog', variant }) {
	const profile = TOXIN_PROFILES[toxinKey];
	if (!profile) return null;
	const res = profile.evaluate({ amount: Number(amount) || 0, weightKg: Number(weightKg) || 1, species, variant });
	return { ...res, profileKey: profile.key, profileLabel: profile.label, unit: profile.unit, notes: profile.notes, variant };
}

/* =========================================================================
 * 6. KLEIBER ALLOMETRY — RER / MER / FLUID THERAPY
 * ========================================================================= */
/** Resting Energy Requirement: RER = 70 · W^0.75 (kcal/day) */
export function kleiberRER(weightKg) {
	return 70 * Math.pow(Math.max(0.1, Number(weightKg) || 0.1), 0.75);
}

export const LIFE_STAGES = [
	{ key: 'neonate', label: 'Neonate (< 8 weeks)', dogK: 3.0, catK: 2.5 },
	{ key: 'juvenile', label: 'Juvenile (growing)', dogK: 2.0, catK: 2.0 },
	{ key: 'intact', label: 'Intact adult', dogK: 1.8, catK: 1.6 },
	{ key: 'neutered', label: 'Neutered adult', dogK: 1.6, catK: 1.2 },
	{ key: 'senior', label: 'Senior (> 7 yr)', dogK: 1.4, catK: 1.2 },
	{ key: 'repro', label: 'Pregnant / lactating', dogK: 3.0, catK: 2.8 }
];

export function merForStage(weightKg, stageKey, species = 'dog') {
	const rer = kleiberRER(weightKg);
	const stage = LIFE_STAGES.find((s) => s.key === stageKey) || LIFE_STAGES[3];
	const k = species === 'cat' ? stage.catK : stage.dogK;
	return { rer, k, mer: rer * k, stage };
}

/**
 * 24-hour fluid plan.
 *   deficit   = W · %dehydration · 10   (mL)
 *   maint     = C · W^0.75               (C = 132 dog | 80 cat)
 *   total     = deficit + maintenance + ongoing losses
 */
export function fluidPlan({ weightKg = 12, dehydrationPct = 5, species = 'dog', ongoingLossMl = 0, hours = 24 }) {
	const w = Math.max(0.1, Number(weightKg) || 0.1);
	const C = species === 'cat' ? 80 : 132;
	const deficitVolume = w * Math.max(0, dehydrationPct) * 10;
	const maintenance = C * Math.pow(w, 0.75);
	const ongoing = Math.max(0, Number(ongoingLossMl) || 0);
	const total = deficitVolume + maintenance + ongoing;
	const mlPerHr = total / Math.max(1, hours);
	// Drop factor 20 gtt/mL for a standard macro-drip set.
	return {
		deficitVolume,
		maintenance,
		ongoing,
		total,
		mlPerHr,
		dropsPerMin: (mlPerHr * 20) / 60,
		replacementHalf: deficitVolume / 2,
		cSpecies: C,
		dehydrationPct
	};
}

/* =========================================================================
 * 7. MDR1 (ABCB1-1Δ) HERDING-BREED PHARMACOGENOMIC RISK
 * ========================================================================= */
export const MDR1_BREEDS = [
	'Collie (Rough / Smooth)',
	'Australian Shepherd',
	'Miniature American Shepherd',
	'Shetland Sheepdog',
	'Border Collie',
	'Old English Sheepdog',
	'German Shepherd (carrier)',
	'Long-haired Whippet',
	'Silken Windhound',
	'McNab',
	'Mixed herding breed'
];

export function mdr1Risk(breed) {
	const listed = MDR1_BREEDS.includes(breed);
	return {
		listed,
		breed,
		title: listed ? 'MDR1 (ABCB1-1Δ) mutation likely — 4× sensitivity' : 'MDR1 risk not flagged',
		body: listed
			? 'Herding-breed MDR1 homozygotes have a non-functional P-glycoprotein efflux pump at the blood–brain barrier. Avoid ivermectin (> 6 µg/kg), loperamide, milbemycin oxime, moxidectin, acepromazine, butorphanol, vincristine and doxorubicin. Use alternative agents or dose 25 % of standard with clinician oversight.'
			: 'No breed-level MDR1 flag. Still screen any dog with neurotoxicity after routine macrocyclic lactone or loperamide dosing.'
	};
}

/* =========================================================================
 * 8. ONE-TAP CLINICAL CASE PRESETS
 * ========================================================================= */
export const CASE_PRESETS = [
	{
		id: 'beagle-dark',
		label: '12 kg Beagle · 85 g 70 % dark chocolate, 45 min ago',
		species: 'dog',
		breed: 'Beagle',
		weightKg: 12,
		lifeStage: 'neutered',
		renal: false,
		hepatic: false,
		scenario: { kind: 'chocolate', matrixKey: 'dark70', massG: 85, minutesSinceIngestion: 45 },
		note: 'Classic paediatric-emergency script: cardiotoxic range, emesis still highly effective.'
	},
	{
		id: 'frenchie-xylitol',
		label: '8.5 kg French Bulldog · 6 pieces xylitol gum (0.3 g each)',
		species: 'dog',
		breed: 'French Bulldog',
		weightKg: 8.5,
		lifeStage: 'neutered',
		renal: false,
		hepatic: false,
		scenario: { kind: 'toxin', toxinKey: 'xylitol', amount: 1800, variant: 'gum', minutesSinceIngestion: 20 },
		note: '212 mg/kg — above the 100 mg/kg hypoglycaemia threshold, below hepatic necrosis.'
	},
	{
		id: 'dsh-lily',
		label: '4.2 kg Domestic Shorthair · lily pollen + 7 % dehydration',
		species: 'cat',
		breed: 'Domestic Shorthair',
		weightKg: 4.2,
		lifeStage: 'neutered',
		renal: false,
		hepatic: false,
		scenario: { kind: 'toxin', toxinKey: 'lily', amount: 1, variant: 'pollen', minutesSinceIngestion: 90, dehydrationPct: 7 },
		note: 'Zero-margin feline nephrotoxic emergency — every minute to fluids matters.'
	},
	{
		id: 'collie-raisin',
		label: '24 kg Border Collie (MDR1+) · raisin trail-mix ingestion',
		species: 'dog',
		breed: 'Border Collie',
		weightKg: 24,
		lifeStage: 'intact',
		renal: false,
		hepatic: false,
		scenario: { kind: 'toxin', toxinKey: 'grape', amount: 90, variant: 'raisin', minutesSinceIngestion: 120, dehydrationPct: 4 },
		note: '3.75 g/kg raisins — above the 2.8 g/kg nephrotoxic threshold, plus MDR1 precaution.'
	}
];

/* =========================================================================
 * 9. CONVENIENCE: FULL INCIDENT SNAPSHOT
 * ========================================================================= */
export function buildIncident({ preset, species, weightKg, lifeStage, scenario }) {
	const sc = scenario || preset?.scenario || {};
	const weight = Number(weightKg) || preset?.weightKg || 10;
	const sp = species || preset?.species || 'dog';
	const stage = lifeStage || preset?.lifeStage || 'neutered';

	const toxReport =
		sc.kind === 'toxin'
			? evaluateToxin({
					toxinKey: sc.toxinKey,
					amount: sc.amount,
					weightKg: weight,
					species: sp,
					variant: sc.variant
			  })
			: null;

	const chocolate =
		sc.kind === 'chocolate'
			? buildMethylxanthineCurve({
					massG: sc.massG,
					matrixKey: sc.matrixKey,
					weightKg: weight,
					species: sp
			  })
			: null;

	const gastric = gastricEmptyingFraction({
		minutesSinceIngestion: sc.minutesSinceIngestion ?? 60,
		tHalfGastricHr: sp === 'cat' ? 1.6 : 2.0
	});

	const energy = merForStage(weight, stage, sp);
	const fluids = fluidPlan({
		weightKg: weight,
		dehydrationPct: sc.dehydrationPct ?? 5,
		species: sp
	});

	const severity = chocolate ? chocolate.dose.zone.key : toxReport?.severity ?? 0;

	return {
		modelVersion: MODEL_VERSION,
		species: sp,
		weightKg: weight,
		lifeStage: stage,
		chocolate,
		toxReport,
		gastric,
		energy,
		fluids,
		severity,
		timestamp: new Date().toISOString()
	};
}
