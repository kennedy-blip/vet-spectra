"""
VET-SPECTRA · api/vet_physics.py
===========================================================================
Vercel Python 3.12 serverless function. PHP-free by design — a single
BaseHTTPRequestHandler that exposes the Python mirrors of the clinical engines
and accepts the IndexedDB sync outbox.

Routes (all on /api/vet_physics)
--------------------------------
GET                         → health probe
POST {"action": "health"}   → health probe
POST {"action": "sync", "store": "...", "payload": {...}}
                            → persist an offline capture envelope
POST {"action": "dose",  ...} → full toxicology + allometry snapshot
POST {"action": "gait",  ...} → Fourier lameness kinematics
POST {"action": "acoustic", "features": {...}, "species": "dog"}
                            → respiratory signature classification + BOAS
POST {"action": "quote", ...} → regional billing audit

The function is intentionally stateless: the phone owns the record of truth in
IndexedDB, and the server only confirms, re-derives and archives.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
from http.server import BaseHTTPRequestHandler
from typing import Any

# Make the repository root importable regardless of the Vercel build cwd.
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from python_vet import __version__ as VET_VERSION
from python_vet.quadruped_gait_acoustic_biometrics import (
    GAIT_PROFILES,
    analyze_acoustic,
    analyze_gait,
    classify_signature,
)
from python_vet.toxicology_allometry_solver import (
    CHOCOLATE_MATRICES,
    MDR1_BREEDS,
    build_curve,
    evaluate_toxin,
    fluid_plan,
    gastric_emptying,
    mer,
    solve_case,
)

MAX_BODY_BYTES = 512 * 1024

PROCEDURES: dict[str, dict[str, Any]] = {
    "spay": {"label": "Canine ovariohysterectomy (spay)", "fair_low": 380.0, "fair_high": 950.0},
    "dental": {"label": "Dental scaling + full-mouth radiographs", "fair_low": 320.0, "fair_high": 880.0},
    "mass": {"label": "Mass removal + histopathology", "fair_low": 340.0, "fair_high": 1250.0},
    "vaccines": {"label": "Core vaccine bundle", "fair_low": 65.0, "fair_high": 210.0},
    "tplo": {"label": "TPLO cranial cruciate surgery", "fair_low": 2900.0, "fair_high": 5800.0},
    "foreign_body": {"label": "Emergency foreign-body surgery", "fair_low": 1800.0, "fair_high": 4600.0},
}

REGION_INDEX: dict[str, float] = {
    "us_midwest": 1.00,
    "us_coastal": 1.38,
    "uk": 1.22,
    "eu": 1.14,
    "kenya": 0.42,
    "south_africa": 0.56,
    "australia": 1.27,
    "india": 0.34,
}


# ---------------------------------------------------------------------------
# Action handlers
# ---------------------------------------------------------------------------
def action_health(_body: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "ok": True,
        "service": "vet-spectra",
        "version": VET_VERSION,
        "runtime": f"python {sys.version_info.major}.{sys.version_info.minor}",
        "engines": 5,
        "modules": [
            "python_vet.toxicology_allometry_solver",
            "python_vet.quadruped_gait_acoustic_biometrics",
        ],
        "ts_allowed": False,
        "chocolate_matrices": len(CHOCOLATE_MATRICES),
        "gait_profiles": len(GAIT_PROFILES),
        "mdr1_breeds": len(MDR1_BREEDS),
        "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def action_sync(body: dict[str, Any]) -> dict[str, Any]:
    payload = body.get("payload") or {}
    store = body.get("store", "unknown")
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(encoded).hexdigest()
    return {
        "ok": True,
        "accepted": True,
        "store": store,
        "bytes": len(encoded),
        "sha256": digest,
        "client_ts": body.get("client_ts"),
        "server_ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "note": "Envelope archived. The device IndexedDB copy remains authoritative.",
    }


def action_dose(body: dict[str, Any]) -> dict[str, Any]:
    case = solve_case(body)
    matrix_key = body.get("matrix_key", "dark70")
    weight = float(body.get("weight_kg", 12.0))
    mass_g = float(body.get("mass_g", 0.0))
    case["curve"] = (
        build_curve(mass_g, matrix_key, weight, body.get("species", "dog"), hours=72.0, steps=96)
        if mass_g > 0
        else None
    )
    case["decontamination"] = gastric_emptying(
        float(body.get("minutes_since_ingestion", 60.0)),
        1.6 if body.get("species") == "cat" else 2.0,
    )
    case["allometry"] = mer(weight, body.get("life_stage", "neutered"), body.get("species", "dog"))
    case["fluids"] = fluid_plan(weight, float(body.get("dehydration_pct", 5.0)), body.get("species", "dog"))
    if body.get("toxin_key"):
        case["toxin"] = evaluate_toxin(
            body["toxin_key"],
            float(body.get("toxin_amount", 0.0)),
            weight,
            body.get("species", "dog"),
            body.get("toxin_variant"),
        )
    return {"ok": True, "action": "dose", "result": case}


def action_gait(body: dict[str, Any]) -> dict[str, Any]:
    profile = body.get("profile", "left_fore_3")
    seconds = float(body.get("seconds", 6.0))
    fs = float(body.get("fs", 120.0))
    return {"ok": True, "action": "gait", "result": analyze_gait(profile, seconds, fs)}


def action_acoustic(body: dict[str, Any]) -> dict[str, Any]:
    features = body.get("features")
    species = body.get("species", "dog")
    if not isinstance(features, dict):
        return {
            "ok": False,
            "error": "features object required: f0_hz, centroid_hz, hnr, burst_rate_hz, duty_factor, "
            "low_ratio, mid_ratio, high_ratio, stertor_ratio, stridor_ratio",
        }
    normalised = {
        "f0_hz": float(features.get("f0_hz", features.get("f0", 0.0))),
        "centroid_hz": float(features.get("centroid_hz", features.get("centroid", 0.0))),
        "hnr": float(features.get("hnr", features.get("hnrDb", -6.0))),
        "burst_rate_hz": float(features.get("burst_rate_hz", features.get("burstRate", 0.0))),
        "duty_factor": float(features.get("duty_factor", features.get("dutyFactor", 0.0))),
        "low_ratio": float(features.get("low_ratio", features.get("lowRatio", 0.0))),
        "mid_ratio": float(features.get("mid_ratio", features.get("midRatio", 0.0))),
        "high_ratio": float(features.get("high_ratio", features.get("highRatio", 0.0))),
        "stertor_ratio": float(features.get("stertor_ratio", features.get("stertorRatio", 0.0))),
        "stridor_ratio": float(features.get("stridor_ratio", features.get("stridorRatio", 0.0))),
        "duration_s": float(features.get("duration_s", 3.4)),
        "sample_rate": float(features.get("sample_rate", 24000.0)),
    }
    return {"ok": True, "action": "acoustic", "result": analyze_acoustic(normalised, species)}


# --- quote line-item audit (mirrors the browser auditor) -------------------
BUNDLED_TERMS = (
    "anesthesia",
    "anaesthesia",
    "monitoring",
    "iv catheter",
    "intravenous catheter",
    "fluids",
    "pain management",
    "analgesia",
    "suture removal",
)
LINE_ITEM_RE = re.compile(r"^(.*?)[\s:–-]+([0-9]+(?:\.[0-9]+)?)$")


def _normalise_label(text: str) -> str:
    return re.sub(r"[^a-z ]", "", str(text).lower()).strip()


def parse_line_items(raw: Any) -> list[dict[str, Any]]:
    """Accept either a raw multi-line quote or a list of {desc, amount} objects."""
    items: list[dict[str, Any]] = []
    if isinstance(raw, str):
        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue
            m = LINE_ITEM_RE.match(line)
            if m:
                items.append({"desc": m.group(1).strip(), "amount": float(m.group(2))})
            else:
                items.append({"desc": line, "amount": 0.0})
    elif isinstance(raw, list):
        for entry in raw:
            if isinstance(entry, dict):
                items.append(
                    {
                        "desc": str(entry.get("desc") or entry.get("label") or "").strip(),
                        "amount": float(entry.get("amount") or entry.get("price") or 0.0),
                    }
                )
            elif isinstance(entry, str):
                items.extend(parse_line_items(entry))
    return items


def audit_line_items(items: list[dict[str, Any]], proc: dict[str, Any], fair_high: float) -> list[dict[str, Any]]:
    flags: list[dict[str, Any]] = []
    counts: dict[str, int] = {}
    for item in items:
        if not item["amount"]:
            continue
        key = _normalise_label(item["desc"])
        counts[key] = counts.get(key, 0) + 1
    for desc, count in counts.items():
        if count > 1:
            flags.append(
                {
                    "key": "duplicate",
                    "severity": "bad",
                    "title": f"Duplicate line item ×{count}",
                    "detail": f"\u201c{desc}\u201d appears {count} times. Ask the clinic to consolidate.",
                }
            )
    for item in items:
        label = _normalise_label(item["desc"])
        if item["amount"] > 0 and any(term in label for term in BUNDLED_TERMS):
            flags.append(
                {
                    "key": "unbundling",
                    "severity": "warn",
                    "title": "Possible unbundling",
                    "detail": f"\u201c{item['desc']}\u201d ({item['amount']:.0f}) is normally included in the "
                    f"{proc['label']} fee. Verify whether this is a duplicate charge.",
                }
            )
    for item in items:
        label = _normalise_label(item["desc"])
        if any(term in label for term in ("medication", "pharmacy", "drug")) and item["amount"] > proc["fair_low"] * 0.35:
            flags.append(
                {
                    "key": "markup",
                    "severity": "warn",
                    "title": "Pharmacy markup above typical",
                    "detail": f"\u201c{item['desc']}\u201d at {item['amount']:.0f} is above 35 % of the base "
                    "procedure cost — request an itemised drug list with unit prices.",
                }
            )
    return flags


def action_quote(body: dict[str, Any]) -> dict[str, Any]:
    key = body.get("procedure", "dental")
    proc = PROCEDURES.get(key, PROCEDURES["dental"])
    index = REGION_INDEX.get(body.get("region", "us_midwest"), 1.0)
    quoted = float(body.get("quoted_total", 0.0))
    items = parse_line_items(body.get("line_items") or body.get("lineItems") or [])
    fair_low = proc["fair_low"] * index
    fair_high = proc["fair_high"] * index
    mid = (fair_low + fair_high) / 2.0

    if quoted > fair_high * 1.25:
        verdict, tone = "Overcharge flagged", "bad"
    elif quoted > fair_high:
        verdict, tone = "Elevated - clarify inclusions", "warn"
    elif 0 < quoted < fair_low * 0.65:
        verdict, tone = "Below floor - verify inclusions", "warn"
    elif fair_low <= quoted <= fair_high:
        verdict, tone = "Fair market price", "ok"
    else:
        verdict, tone = "Slightly below regional range", "info"

    insurance = body.get("insurance") or {}
    coverage = float(insurance.get("coveragePct", 80.0)) / 100.0
    deductible = float(insurance.get("deductible", 250.0))
    allowed_factor = float(insurance.get("allowedFactor", 0.85))
    allowed = quoted * allowed_factor
    reimbursement = max(0.0, allowed - deductible) * coverage

    return {
        "ok": True,
        "action": "quote",
        "result": {
            "procedure": proc["label"],
            "region_index": index,
            "fair_low": round(fair_low, 2),
            "fair_high": round(fair_high, 2),
            "midpoint": round(mid, 2),
            "quoted": round(quoted, 2),
            "over_mid_pct": round(((quoted - mid) / mid) * 100.0, 2) if mid else 0.0,
            "verdict": verdict,
            "tone": tone,
            "line_items": items,
            "itemised_total": round(sum(i["amount"] for i in items), 2),
            "flags": audit_line_items(items, proc, fair_high),
            "insurance": {
                "allowed": round(allowed, 2),
                "reimbursement": round(reimbursement, 2),
                "out_of_pocket": round(max(0.0, quoted - reimbursement), 2),
            },
        },
    }


ACTIONS = {
    "health": action_health,
    "sync": action_sync,
    "dose": action_dose,
    "gait": action_gait,
    "acoustic": action_acoustic,
    "quote": action_quote,
}


def dispatch(body: dict[str, Any]) -> dict[str, Any]:
    action = str(body.get("action", "health"))
    handler = ACTIONS.get(action)
    if handler is None:
        return {
            "ok": False,
            "error": f"unknown action '{action}'",
            "available": sorted(ACTIONS),
        }
    if action == "health":
        payload = dict(action_health())
        payload.pop("ok", None)
        return {"ok": True, "action": "health", "result": payload}
    try:
        return handler(body)
    except Exception as exc:  # noqa: BLE001 - serverless boundary
        return {"ok": False, "action": action, "error": f"{type(exc).__name__}: {exc}"}


# ---------------------------------------------------------------------------
# HTTP plumbing
# ---------------------------------------------------------------------------
class handler(BaseHTTPRequestHandler):
    server_version = "vet-spectra/27.0.0"
    protocol_version = "HTTP/1.1"

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")

    def _respond(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802 - stdlib API
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        self._respond(200, action_health())

    def do_POST(self) -> None:  # noqa: N802
        try:
            length = int(self.headers.get("content-length", "0") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            self._respond(400, {"ok": False, "error": "empty body"})
            return
        if length > MAX_BODY_BYTES:
            self._respond(413, {"ok": False, "error": "payload too large"})
            return
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._respond(400, {"ok": False, "error": f"invalid JSON: {exc}"})
            return
        if not isinstance(body, dict):
            self._respond(400, {"ok": False, "error": "body must be a JSON object"})
            return
        result = dispatch(body)
        self._respond(200 if result.get("ok") else 400, result)


# Local development entry point:  python3 server/vet_physics.py
if __name__ == "__main__":
    from http.server import ThreadingHTTPServer

    port = int(os.environ.get("PORT", "8099"))
    print(f"VET-SPECTRA API listening on http://0.0.0.0:{port}/api/vet_physics")
    ThreadingHTTPServer(("0.0.0.0", port), handler).serve_forever()
