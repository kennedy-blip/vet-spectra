#!/usr/bin/env python3
"""
Python mirror checks — the reference numbers both engines must agree on.

Runs the same clinical cases as the browser suite against the Python modules
through the API router, so JS/Python parity is proved on every CI run.

    python3 scripts/check-engines.py
"""

from __future__ import annotations

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from api.vet_physics import dispatch  # noqa: E402

FAILURES: list[str] = []


def check(label: str, actual, expected, tol: float = 0.05) -> None:
    if isinstance(expected, bool) or actual is None or expected is None:
        ok = actual is expected or actual == expected
    elif isinstance(expected, str):
        ok = actual == expected
    else:
        ok = abs(float(actual) - float(expected)) <= tol
    print(f"{'PASS' if ok else 'FAIL'}  {label}: {actual!r} (expected {expected!r})")
    if not ok:
        FAILURES.append(label)


def main() -> int:
    health = dispatch({"action": "health"})
    check("health ok", health.get("ok"), True)
    print(f"PASS  health service: {health['result']['service']} {health['result']['version']}")

    dose = dispatch(
        {
            "action": "dose",
            "weight_kg": 12,
            "mass_g": 85,
            "matrix_key": "dark70",
            "species": "dog",
            "minutes_since_ingestion": 45,
        }
    )["result"]
    check("dose 85 g dark70 / 12 kg dog", dose["dose"]["dose_total_mg_kg"], 53.83, 0.05)
    check("dose zone", dose["dose"]["zone"]["key"], "cardio")
    check("Kleiber RER 12 kg", dose["energy"]["rer_kcal_day"], 451.32, 0.05)
    check("fluid deficit 12 kg @ 5 %", dose["fluids"]["deficit_ml"], 600.0, 0.01)
    check("fluid maintenance 12 kg", dose["fluids"]["maintenance_ml"], 851.06, 0.01)
    check("PK curve points", len(dose["curve"]["points"]), 97, 0)

    lame = dispatch({"action": "gait", "profile": "left_fore_3"})["result"]
    check("left_fore_3 LAI > 12", lame["dominant_lai_pct"] > 12, True)
    check("left_fore_3 lame limb", lame["lame_limb"], "LF")
    check("left_fore_3 phase limb", lame["phase_limb"], "LF")
    check("left_fore_3 AAHA >= 2", lame["aaha_score"] >= 2, True)

    sound = dispatch({"action": "gait", "profile": "sound_trot"})["result"]
    check("sound_trot LAI < 6", sound["dominant_lai_pct"] < 6, True)
    check("sound_trot claims no lame limb", sound["phase_limb"], None)

    quote = dispatch(
        {
            "action": "quote",
            "procedure": "dental",
            "quoted_total": 1200,
            "region": "us_midwest",
            "line_items": "Dental scaling: 640\nAnesthesia: 280\nAnesthesia: 280",
        }
    )["result"]
    keys = {f["key"] for f in quote["flags"]}
    check("quote duplicate flag", "duplicate" in keys, True)
    check("quote unbundling flag", "unbundling" in keys, True)
    check("quote verdict tone", quote["tone"], "bad")

    acoustic = dispatch(
        {
            "action": "acoustic",
            "species": "cat",
            "features": {
                "f0_hz": 26.4,
                "centroid_hz": 625.0,
                "hnr": 10.8,
                "burst_rate_hz": 0.24,
                "duty_factor": 0.8,
                "low_ratio": 0.14,
                "mid_ratio": 0.68,
                "high_ratio": 0.09,
                "stertor_ratio": 0.19,
                "stridor_ratio": 0.09,
            },
        }
    )["result"]
    check("acoustic purr wins the differential", acoustic["top_match"]["key"], "purr")
    check("BOAS not scored for cats", acoustic["boas"], None)

    sync = dispatch({"action": "sync", "store": "gait_reports", "payload": {"n": 1}})
    check("sync accepted", sync.get("accepted"), True)
    check("sync digest length", len(sync.get("sha256", "")), 64, 0)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} check(s) failed: {', '.join(FAILURES)}")
        return 1
    print("python engines OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
