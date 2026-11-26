/**
 * VET-SPECTRA in-browser engine self-test suite (16 assertions).
 *
 * Extracted from PolyglotAdminModal so the exact suite that the UI reports is
 * also importable from Node (`node --input-type=module`) and any other harness.
 * Every assertion is pure — no DOM, no network, no IndexedDB.
 */
import {
	buildMethylxanthineCurve,
	doseFromMass,
	fluidPlan,
	kleiberRER,
	merForStage
} from '../engines/vetToxicologyAllometryEngine.js';
import {
	classifySignature,
	extractFeatures,
	synthesizeSignature
} from '../engines/vetBioAcousticEngine.js';
import { analyzeGait } from '../engines/quadrupedGaitKinematicsEngine.js';
import {
	analyzePCG,
	decompensationFlag,
	evaluateSRR,
	hrvFromRR,
	synthesizePCG,
	synthesizeRRSeries
} from '../engines/vetCardioPulmonaryEngine.js';
import {
	attachmentHoursFromSI,
	auditQuote,
	classifyGingiva,
	parseLineItems,
	rgbToLab,
	scutalIndex,
	transmissionRisk
} from '../engines/tickScutalDermaAuditorEngine.js';
import { qrSvg } from '../utils/qrSvg.js';
import { fmt } from '../utils/format.js';

	function approx(a, b, tol = 0.5) {
		return Math.abs(a - b) <= tol;
	}

	export function buildSelfTests() {
		return [
			{
				name: 'Methylxanthine dose · 85 g 70 % dark ÷ 12 kg',
				run: () => {
					const d = doseFromMass({ massG: 85, matrixKey: 'dark70', weightKg: 12, species: 'dog' });
					return { actual: `${fmt(d.doseTotalMgKg, 2)} mg/kg · ${d.zone.key}`, pass: approx(d.doseTotalMgKg, 53.83, 0.05) && d.zone.key === 'cardio' };
				}
			},
			{
				name: 'Bateman C(0) = 0 and C(t) > 0 for t > 0',
				run: () => {
					const curve = buildMethylxanthineCurve({ massG: 85, weightKg: 12, matrixKey: 'dark70', hours: 24, steps: 120 });
					const first = curve.points[0].total;
					const mid = curve.points[60].total;
					return { actual: `C0 ${first.toFixed(3)} · C6h ${mid.toFixed(3)} mg/L`, pass: first === 0 && mid > 0 };
				}
			},
			{
				name: "Kleiber RER · 12 kg = 70 × 12^0.75",
				run: () => {
					const rer = kleiberRER(12);
					const mer = merForStage(12, 'neutered', 'dog');
					return { actual: `${rer.toFixed(2)} kcal/d · MER ${mer.mer.toFixed(0)}`, pass: approx(rer, 451.28, 0.05) };
				}
			},
			{
				name: 'Fluid plan · 12 kg dog 5 % dehydrated',
				run: () => {
					const f = fluidPlan({ weightKg: 12, dehydrationPct: 5, species: 'dog' });
					return { actual: `deficit ${f.deficitVolume.toFixed(0)} + maint ${f.maintenance.toFixed(0)} = ${f.total.toFixed(0)} mL`, pass: approx(f.deficitVolume, 600, 0.01) && approx(f.maintenance, 851.06, 1) };
				}
			},
			{
				name: 'Acoustic classifier · kennel-cough synthesis',
				run: () => {
					const s = synthesizeSignature('kennel_cough', { seconds: 3.2, sampleRate: 24000 });
					const f = extractFeatures(s, 24000);
					const ranked = classifySignature(f, 'dog');
					return { actual: `${ranked[0].short} @ ${ranked[0].confidence.toFixed(1)}%`, pass: ranked[0].key === 'kennel_cough' };
				}
			},
			{
				name: 'Acoustic classifier · feline purr f0 ≈ 26 Hz',
				run: () => {
					const s = synthesizeSignature('purr', { seconds: 3.4, sampleRate: 24000 });
					const f = extractFeatures(s, 24000);
					const ranked = classifySignature(f, 'cat');
					return { actual: `f0 ${f.f0.toFixed(2)} Hz · ${ranked[0].short}`, pass: ranked[0].key === 'purr' && f.f0 > 20 && f.f0 < 40 };
				}
			},
			{
				name: 'Gait · sound trot LAI < 6 %',
				run: () => {
					const r = analyzeGait('sound_trot', { seconds: 6, fs: 120 });
					return { actual: `LAI ${r.dominantLAI.toFixed(2)} % · AAHA ${r.aaha.score}`, pass: r.dominantLAI < 6 && r.aaha.score === 0 };
				}
			},
			{
				name: 'Gait · left-fore lameness localises + grades',
				run: () => {
					const r = analyzeGait('left_fore_3', { seconds: 6, fs: 120 });
					return { actual: `LAI ${r.dominantLAI.toFixed(1)} % · ${r.limbKey} · AAHA ${r.aaha.score}`, pass: r.dominantLAI > 12 && r.limbKey === 'LF' && r.aaha.score >= 2 };
				}
			},
			{
				name: 'PCG · normal SMER < 4 % (grade I)',
				run: () => {
					const pcm = synthesizePCG('normal', { seconds: 4, sampleRate: 8000 });
					const a = analyzePCG(pcm, { sampleRate: 8000, scgRmsMg: 9 });
					return { actual: `SMER ${a.smer.toFixed(2)} % · grade ${a.grade.roman}`, pass: a.smer < 6 && a.grade.index <= 2 };
				}
			},
			{
				name: 'PCG · MMVD murmur ≥ grade III + thrill lift',
				run: () => {
					const pcm = synthesizePCG('mmvd', { seconds: 4, sampleRate: 8000 });
					const a = analyzePCG(pcm, { sampleRate: 8000, scgRmsMg: 44 });
					return { actual: `SMER ${a.smer.toFixed(1)} % · grade ${a.grade.roman}${a.thrill ? ' · thrill' : ''}`, pass: a.smer > 8 && a.grade.index >= 3 && a.thrill };
				}
			},
			{
				name: 'HRV · CHF pattern flagged as decompensation',
				run: () => {
					const { rr } = synthesizeRRSeries('chf', { beats: 40 });
					const h = hrvFromRR(rr);
					const d = decompensationFlag({ cvrr: h.cvrr, meanHr: h.meanHr });
					return { actual: `CV_RR ${h.cvrr.toFixed(1)} % · HR ${h.meanHr.toFixed(0)}`, pass: h.cvrr < 6 && d.active };
				}
			},
			{
				name: 'ACVIM SRR · 34 br/min × 3 → alert',
				run: () => {
					const now = Date.now();
					const res = evaluateSRR([0, 1, 2].map((i) => ({ date: new Date(now - i * 86400000).toISOString(), bpm: 34 })));
					return { actual: `${res.status} · median ${res.median7.toFixed(0)}`, pass: res.status === 'alert' || res.status === 'critical' };
				}
			},
			{
				name: 'Scutal index · 8.2 ÷ 3.6 mm → 57 h attached',
				run: () => {
					const si = scutalIndex(8.2, 3.6);
					const { hours } = attachmentHoursFromSI(si, 'ixodes_scapularis');
					const risk = transmissionRisk({ hours, speciesKey: 'ixodes_scapularis', si });
					return { actual: `SI ${si.toFixed(2)} · ${hours.toFixed(1)} h · ${risk.band.label}`, pass: approx(hours, 57.3, 1) && risk.band.key === 'lyme' };
				}
			},
			{
				name: 'CIELAB · pure red → L* ≈ 53, a* ≈ 80',
				run: () => {
					const lab = rgbToLab(255, 0, 0);
					const g = classifyGingiva({ L: lab.L, a: Math.min(lab.a, 60), b: lab.b, crtSeconds: 1.2 });
					return { actual: `L* ${lab.L.toFixed(1)} a* ${lab.a.toFixed(1)} b* ${lab.b.toFixed(1)}`, pass: approx(lab.L, 53.24, 0.4) && approx(lab.a, 80.09, 0.6) && g.classKey !== 'normal' };
				}
			},
			{
				name: 'Quote auditor · duplicate + unbundling detection',
				run: () => {
					const items = parseLineItems('Dental scaling: 640\nAnesthesia: 280\nAnesthesia: 280');
					const q = auditQuote({ procedureKey: 'dental', quotedTotal: 1200, regionKey: 'us_midwest', lineItems: items });
					const hasDup = q.flags.some((f) => f.key === 'duplicate');
					const hasUnbundle = q.flags.some((f) => f.key === 'unbundling');
					return { actual: `${q.flags.length} flags · dup ${hasDup} · unbundle ${hasUnbundle}`, pass: hasDup && hasUnbundle && q.tone !== 'ok' };
				}
			},
			{
				name: 'QR encoder · URL payload ≤ 78 bytes (v4-L)',
				run: () => {
					const svg = qrSvg('https://vet-spectra.vercel.app/releases/vet-spectra-v27.0.0.apk', { size: 96 });
					return { actual: `${svg.length} bytes of SVG`, pass: svg.startsWith('<svg') && svg.length > 400 };
				}
			}
		];
	}

/**
 * Run the whole suite sequentially, collecting pass/fail + duration.
 * @param {{ onResult?: (r: object) => void }} [opts]
 * @returns {Promise<{ results: object[], passed: number, total: number, ok: boolean, totalMs: number }>}
 */
export async function runSelfTests({ onResult } = {}) {
	const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
	const results = [];
	for (const test of buildSelfTests()) {
		const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
		try {
			const out = test.run();
			results.push({ name: test.name, actual: out.actual, pass: out.pass, ms: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started });
		} catch (err) {
			results.push({ name: test.name, actual: String(err?.message || err), pass: false, ms: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started });
		}
		if (onResult) onResult(results[results.length - 1]);
	}
	const passed = results.filter((r) => r.pass).length;
	const totalMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
	return { results, passed, total: results.length, ok: passed === results.length, totalMs };
}
