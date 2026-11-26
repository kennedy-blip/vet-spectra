"""
VET-SPECTRA · toxicology_allometry_solver
===========================================================================
Precision veterinary toxicology mathematics — Python 3.12 mirror of
``src/lib/engines/vetToxicologyAllometryEngine.js``.

Everything here is pure standard-library Python and deterministic, so the
serverless function can re-derive exactly the numbers the clinician saw on the
handset while it was offline.

Units
-----
dose      : mg of alkaloid per kg of body weight (mg/kg)
mass      : grams of ingested product
volume    : litres of distribution per kg (L/kg)
time      : hours unless the parameter name says otherwise
"""

from __future__ import annotations

import math
from typing import Any, Iterable

MODEL_VERSION = "vet-spectra/pk-27.0.0"

# ---------------------------------------------------------------------------
# 1. Chocolate / caffeine dry-matter alkaloid matrix (mg per gram)
# ---------------------------------------------------------------------------
CHOCOLATE_MATRICES: dict[str, dict[str, Any]] = {
    "white": {"label": "White Chocolate", "theo": 0.009, "caff": 0.003},
    "milk": {"label": "Milk Chocolate", "theo": 2.05, "caff": 0.21},
    "semisweet": {"label": "Semi-Sweet Dark (55% cacao)", "theo": 4.59, "caff": 0.60},
    "dark70": {"label": "Dark Chocolate (70-72% cacao)", "theo": 6.80, "caff": 0.80},
    "extradark": {"label": "Extra-Dark Chocolate (85% cacao)", "theo": 8.85, "caff": 1.05},
    "bakers": {"label": "Unsweetened Baker's Chocolate", "theo": 14.10, "caff": 1.50},
    "cocoa": {"label": "Dry Unsweetened Cocoa Powder", "theo": 26.00, "caff": 2.30},
    "espresso": {"label": "Espresso / Roasted Coffee Grounds", "theo": 0.0, "caff": 12.50},
    "mulch": {"label": "Cocoa Bean Hull Garden Mulch", "theo": 18.20, "caff": 1.60},
}

# ---------------------------------------------------------------------------
# 2. Species pharmacokinetics
# ---------------------------------------------------------------------------
_LN2 = math.log(2.0)

PK_PARAMETERS: dict[str, dict[str, dict[str, float]]] = {
    "dog": {
        "theo": {
            "t12": 17.5,
            "ke": _LN2 / 17.5,
            "ka": 0.35,
            "vd": 0.68,
            "f": 0.77,
            "recirc_fraction": 0.19,
            "recirc_lag_hr": 5.4,
            "recirc_ka": 0.22,
        },
        "caff": {"t12": 4.5, "ke": _LN2 / 4.5, "ka": 1.40, "vd": 0.70, "f": 1.00},
    },
    "cat": {
        "theo": {
            "t12": 25.5,
            "ke": _LN2 / 25.5,
            "ka": 0.30,
            "vd": 0.62,
            "f": 0.72,
            "recirc_fraction": 0.23,
            "recirc_lag_hr": 6.1,
            "recirc_ka": 0.20,
        },
        "caff": {"t12": 6.2, "ke": _LN2 / 6.2, "ka": 1.20, "vd": 0.75, "f": 0.95},
    },
}

METHYLXANTHINE_ZONES: tuple[dict[str, Any], ...] = (
    {"key": "subclinical", "label": "Sub-Clinical", "max": 20.0, "tone": "ok"},
    {"key": "gi", "label": "GI Distress", "max": 40.0, "tone": "warn"},
    {"key": "cardio", "label": "Cardiotoxic Arrhythmia", "max": 60.0, "tone": "bad"},
    {"key": "neuro", "label": "Neurotoxic Seizures", "max": 100.0, "tone": "bad"},
    {"key": "ld50", "label": ">= LD50 Critical", "max": math.inf, "tone": "bad"},
)

MDR1_BREEDS: tuple[str, ...] = (
    "Collie (Rough / Smooth)",
    "Australian Shepherd",
    "Miniature American Shepherd",
    "Shetland Sheepdog",
    "Border Collie",
    "Old English Sheepdog",
    "German Shepherd (carrier)",
    "Long-haired Whippet",
    "Silken Windhound",
    "McNab",
    "Mixed herding breed",
)

LIFE_STAGES: dict[str, dict[str, Any]] = {
    "neonate": {"label": "Neonate (< 8 weeks)", "dog_k": 3.0, "cat_k": 2.5},
    "juvenile": {"label": "Juvenile (growing)", "dog_k": 2.0, "cat_k": 2.0},
    "intact": {"label": "Intact adult", "dog_k": 1.8, "cat_k": 1.6},
    "neutered": {"label": "Neutered adult", "dog_k": 1.6, "cat_k": 1.2},
    "senior": {"label": "Senior (> 7 yr)", "dog_k": 1.4, "cat_k": 1.2},
    "repro": {"label": "Pregnant / lactating", "dog_k": 3.0, "cat_k": 2.8},
}


# ---------------------------------------------------------------------------
# 3. Pharmacokinetics
# ---------------------------------------------------------------------------
def bateman(
    t_hr: float,
    dose_mg_kg: float,
    ka: float,
    ke: float,
    vd: float,
    lag_hr: float = 0.0,
    f: float = 1.0,
) -> float:
    """One-compartment first-order absorption -> elimination concentration."""
    t = t_hr - lag_hr
    if t <= 0:
        return 0.0
    if abs(ka - ke) < 1e-12:
        return f * dose_mg_kg * ka * t * math.exp(-ke * t) / vd
    return (f * dose_mg_kg * ka) / (vd * (ka - ke)) * (math.exp(-ke * t) - math.exp(-ka * t))


def plasma_concentration(
    t_hr: float,
    dose_theo_mg_kg: float,
    dose_caff_mg_kg: float,
    species: str = "dog",
    recirculation: bool = True,
) -> dict[str, float]:
    """Theobromine + caffeine plasma concentration (mg/L), with enterohepatic recirculation."""
    p = PK_PARAMETERS.get(species, PK_PARAMETERS["dog"])
    theo_p = p["theo"]
    caff_p = p["caff"]

    theo = bateman(t_hr, dose_theo_mg_kg, theo_p["ka"], theo_p["ke"], theo_p["vd"], 0.0, theo_p["f"])
    if recirculation:
        theo += bateman(
            t_hr,
            dose_theo_mg_kg * theo_p["recirc_fraction"],
            theo_p["recirc_ka"],
            theo_p["ke"],
            theo_p["vd"],
            theo_p["recirc_lag_hr"],
            theo_p["f"],
        )
    caff = bateman(t_hr, dose_caff_mg_kg, caff_p["ka"], caff_p["ke"], caff_p["vd"], 0.0, caff_p["f"])
    theo = max(0.0, theo)
    caff = max(0.0, caff)
    return {"theobromine": theo, "caffeine": caff, "total": theo + caff}


def classify_methylxanthine(total_mg_kg: float) -> dict[str, Any]:
    if not math.isfinite(total_mg_kg) or total_mg_kg <= 0:
        return dict(METHYLXANTHINE_ZONES[0])
    for zone in METHYLXANTHINE_ZONES:
        if total_mg_kg < zone["max"]:
            return dict(zone)
    return dict(METHYLXANTHINE_ZONES[-1])


def dose_from_mass(
    mass_g: float,
    matrix_key: str,
    weight_kg: float,
    species: str = "dog",
) -> dict[str, Any]:
    matrix = CHOCOLATE_MATRICES.get(matrix_key, CHOCOLATE_MATRICES["dark70"])
    w = max(0.1, float(weight_kg or 0.1))
    grams = max(0.0, float(mass_g or 0.0))
    theo_mg = grams * matrix["theo"]
    caff_mg = grams * matrix["caff"]
    dose_theo = theo_mg / w
    dose_caff = caff_mg / w
    total = dose_theo + dose_caff
    return {
        "species": species,
        "matrix": matrix_key,
        "matrix_label": matrix["label"],
        "mass_g": grams,
        "weight_kg": w,
        "theobromine_mg": round(theo_mg, 4),
        "caffeine_mg": round(caff_mg, 4),
        "dose_theobromine_mg_kg": round(dose_theo, 4),
        "dose_caffeine_mg_kg": round(dose_caff, 4),
        "dose_total_mg_kg": round(total, 4),
        "zone": classify_methylxanthine(total),
    }


def build_curve(
    mass_g: float,
    matrix_key: str,
    weight_kg: float,
    species: str = "dog",
    hours: float = 72.0,
    steps: int = 360,
    recirculation: bool = True,
) -> dict[str, Any]:
    """Sample the Bateman curve; returns the same shape as the JS engine."""
    dose = dose_from_mass(mass_g, matrix_key, weight_kg, species)
    n = max(8, int(steps))
    dt = hours / n
    points: list[dict[str, float]] = []
    peak_t = 0.0
    peak_total = 0.0
    for i in range(n + 1):
        t = i * dt
        c = plasma_concentration(
            t,
            dose["dose_theobromine_mg_kg"],
            dose["dose_caffeine_mg_kg"],
            species,
            recirculation,
        )
        if c["total"] > peak_total:
            peak_total = c["total"]
            peak_t = t
        points.append(
            {
                "t": round(t, 4),
                "theobromine": round(c["theobromine"], 6),
                "caffeine": round(c["caffeine"], 6),
                "total": round(c["total"], 6),
            }
        )
    return {
        "model_version": MODEL_VERSION,
        "dose": dose,
        "hours": hours,
        "steps": n,
        "peak": {"t": round(peak_t, 3), "c_mg_l": round(peak_total, 4)},
        "points": points,
    }


# ---------------------------------------------------------------------------
# 4. Decontamination window
# ---------------------------------------------------------------------------
def gastric_emptying(minutes_since_ingestion: float, t_half_gastric_hr: float = 2.0) -> dict[str, Any]:
    """Residual gastric fraction G(t) = 100 · e^(−(ln2 / t½)·Δt)."""
    dt = max(0.0, float(minutes_since_ingestion)) / 60.0
    k = _LN2 / max(0.1, float(t_half_gastric_hr))
    residual = 100.0 * math.exp(-k * dt)

    def minutes_until(pct: float) -> float:
        return max(0.0, (-math.log(pct / 100.0) / k - dt) * 60.0)

    return {
        "minutes_since_ingestion": float(minutes_since_ingestion),
        "t_half_gastric_hr": t_half_gastric_hr,
        "residual_pct": round(residual, 3),
        "emesis_effective": residual >= 40.0,
        "charcoal_effective": residual >= 15.0,
        "minutes_until_emesis_window": round(minutes_until(40.0), 1),
        "minutes_until_charcoal_window": round(minutes_until(15.0), 1),
    }


# ---------------------------------------------------------------------------
# 5. Kleiber allometry & fluid therapy
# ---------------------------------------------------------------------------
def kleiber_rer(weight_kg: float) -> float:
    """Resting energy requirement: 70 · W^0.75 kcal/day."""
    return 70.0 * math.pow(max(0.1, float(weight_kg or 0.1)), 0.75)


def mer(weight_kg: float, stage: str = "neutered", species: str = "dog") -> dict[str, Any]:
    rer = kleiber_rer(weight_kg)
    row = LIFE_STAGES.get(stage, LIFE_STAGES["neutered"])
    k = row["cat_k"] if species == "cat" else row["dog_k"]
    return {
        "rer_kcal_day": round(rer, 3),
        "factor": k,
        "mer_kcal_day": round(rer * k, 3),
        "stage": row["label"],
    }


def fluid_plan(
    weight_kg: float,
    dehydration_pct: float = 5.0,
    species: str = "dog",
    ongoing_loss_ml: float = 0.0,
    hours: float = 24.0,
) -> dict[str, Any]:
    """deficit (W·%·10) + maintenance (C·W^0.75, C = 132 dog | 80 cat) + ongoing."""
    w = max(0.1, float(weight_kg or 0.1))
    c = 80.0 if species == "cat" else 132.0
    deficit = w * max(0.0, float(dehydration_pct)) * 10.0
    maintenance = c * math.pow(w, 0.75)
    ongoing = max(0.0, float(ongoing_loss_ml or 0.0))
    total = deficit + maintenance + ongoing
    ml_per_hr = total / max(1.0, hours)
    return {
        "deficit_ml": round(deficit, 2),
        "maintenance_ml": round(maintenance, 2),
        "ongoing_ml": round(ongoing, 2),
        "total_ml": round(total, 2),
        "ml_per_hr": round(ml_per_hr, 2),
        "drops_per_min_20gtt": round(ml_per_hr * 20.0 / 60.0, 1),
        "coefficient_c": c,
    }


# ---------------------------------------------------------------------------
# 6. Multi-toxin emergency thresholds
# ---------------------------------------------------------------------------
def evaluate_toxin(
    toxin_key: str,
    amount: float,
    weight_kg: float,
    species: str = "dog",
    variant: str | None = None,
) -> dict[str, Any]:
    """Subset of the browser toxin matrix covering the five classroom emergencies."""
    w = max(0.1, float(weight_kg or 0.1))
    amount = max(0.0, float(amount or 0.0))

    if toxin_key == "xylitol":
        dose = amount / w
        if dose >= 500:
            sev, headline = 4, "Acute hepatic necrosis threshold exceeded"
        elif dose >= 100:
            sev, headline = 3, "Hypoglycaemia threshold exceeded (>= 100 mg/kg)"
        elif dose > 0:
            sev, headline = 1, "Below canine hypoglycaemia threshold"
        else:
            sev, headline = 0, "No exposure entered"
        return {
            "toxin": "xylitol",
            "dose": round(dose, 2),
            "unit": "mg/kg",
            "severity": sev,
            "headline": headline,
        }

    if toxin_key == "allium":
        potency = {"onion_raw": 1.0, "onion_cooked": 1.2, "garlic": 5.0, "leek": 0.6, "powder": 4.0}.get(
            variant or "onion_raw", 1.0
        )
        onion_eq = amount * potency / w
        threshold = 1.0 if species == "cat" else 5.0
        ratio = onion_eq / threshold
        sev = 4 if ratio >= 2 else 3 if ratio >= 1 else 2 if ratio >= 0.5 else 1 if ratio > 0 else 0
        return {
            "toxin": "allium",
            "onion_equivalent_g_kg": round(onion_eq, 3),
            "threshold_g_kg": threshold,
            "severity": sev,
            "headline": "Marked haemolytic dose" if ratio >= 2 else "Above haemolysis threshold" if ratio >= 1 else "Sub-threshold",
        }

    if toxin_key == "grape":
        thresholds = {"grape": 19.6, "raisin": 2.8, "juice": 8.0}
        thr = thresholds.get(variant or "raisin", 2.8)
        g_kg = amount / w
        sev = 4 if g_kg >= thr else 2 if g_kg >= thr * 0.4 else 1 if g_kg > 0 else 0
        return {
            "toxin": "grape",
            "g_kg": round(g_kg, 3),
            "threshold_g_kg": thr,
            "severity": sev,
            "headline": "Nephrotoxic threshold exceeded" if g_kg >= thr else "Idiosyncratic risk zone",
        }

    if toxin_key == "nsaid":
        mg_kg = amount / w
        tiers = {"ibuprofen": 25.0, "naproxen": 5.0, "aspirin": 25.0}.get(variant or "ibuprofen", 25.0)
        if (variant or "").startswith("acetaminophen"):
            tiers = 10.0 if species == "cat" else 75.0
        sev = 4 if mg_kg >= tiers * 4 else 3 if mg_kg >= tiers * 2 else 2 if mg_kg >= tiers else 1 if mg_kg > 0 else 0
        return {
            "toxin": "nsaid",
            "mg_kg": round(mg_kg, 2),
            "first_threshold_mg_kg": tiers,
            "severity": sev,
            "headline": "Above published toxic threshold" if mg_kg >= tiers else "Below published thresholds",
        }

    if toxin_key == "lily":
        sev = 4 if species == "cat" else 1
        return {
            "toxin": "lily",
            "severity": sev,
            "headline": "Feline true-lily emergency" if species == "cat" else "Canine exposure - GI irritant only",
        }

    return {"toxin": toxin_key, "severity": 0, "headline": "Unsupported toxin key"}


# ---------------------------------------------------------------------------
# 7. Orchestration
# ---------------------------------------------------------------------------
def solve_case(payload: dict[str, Any]) -> dict[str, Any]:
    """
    Full incident snapshot — the server-side twin of ``buildIncident()``.

    Expected payload keys (all optional):
        species, weight_kg, life_stage, matrix_key, mass_g,
        minutes_since_ingestion, dehydration_pct, toxin_key, toxin_amount,
        toxin_variant, recirculation
    """
    species = payload.get("species", "dog")
    weight = float(payload.get("weight_kg", 12.0))
    stage = payload.get("life_stage", "neutered")
    matrix_key = payload.get("matrix_key", "dark70")
    mass_g = float(payload.get("mass_g", 0.0))
    minutes = float(payload.get("minutes_since_ingestion", 60.0))
    dehydration = float(payload.get("dehydration_pct", 5.0))
    toxin_key = payload.get("toxin_key")

    dose = dose_from_mass(mass_g, matrix_key, weight, species) if mass_g > 0 else None
    curve = (
        build_curve(
            mass_g,
            matrix_key,
            weight,
            species,
            hours=72.0,
            steps=144,
            recirculation=bool(payload.get("recirculation", True)),
        )
        if mass_g > 0
        else None
    )
    toxin = (
        evaluate_toxin(toxin_key, float(payload.get("toxin_amount", 0.0)), weight, species, payload.get("toxin_variant"))
        if toxin_key
        else None
    )

    return {
        "model_version": MODEL_VERSION,
        "species": species,
        "weight_kg": weight,
        "dose": dose,
        "peak": curve["peak"] if curve else None,
        "curve_sample": curve["points"][:: max(1, len(curve["points"]) // 24)] if curve else [],
        "gastric": gastric_emptying(minutes, 1.6 if species == "cat" else 2.0),
        "energy": mer(weight, stage, species),
        "fluids": fluid_plan(weight, dehydration, species),
        "toxin": toxin,
        "mdr1_flagged": payload.get("breed") in MDR1_BREEDS,
    }


def batch_summary(cases: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Compact per-case summary used by the vault export endpoint."""
    out: list[dict[str, Any]] = []
    for case in cases:
        res = solve_case(case)
        dose = res.get("dose") or {}
        out.append(
            {
                "patient": case.get("patient_id"),
                "species": res["species"],
                "weight_kg": res["weight_kg"],
                "dose_total_mg_kg": dose.get("dose_total_mg_kg"),
                "zone": (dose.get("zone") or {}).get("key"),
                "fluids_ml": res["fluids"]["total_ml"],
            }
        )
    return out
