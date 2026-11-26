"""
VET-SPECTRA · quadruped_gait_acoustic_biometrics
===========================================================================
Python 3.12 mirror of ``quadrupedGaitKinematicsEngine.js`` (Fourier lameness
kinematics) and the analysis half of ``vetBioAcousticEngine.js`` (feature
extraction + respiratory signature classification).

Standard library only. Deterministic — the gait simulator is seeded so the
server can reproduce a handset capture exactly.
"""

from __future__ import annotations

import cmath
import math
import random
from typing import Any, Iterable, Sequence

MODEL_VERSION = "vet-spectra/gait-acoustic-27.0.0"

LIMBS: tuple[dict[str, Any], ...] = (
    {"key": "LF", "label": "Left Fore", "group": "fore", "phase": 0.00},
    {"key": "RF", "label": "Right Fore", "group": "fore", "phase": 0.50},
    {"key": "LH", "label": "Left Hind", "group": "hind", "phase": 0.25},
    {"key": "RH", "label": "Right Hind", "group": "hind", "phase": 0.75},
)

GAIT_PROFILES: dict[str, dict[str, Any]] = {
    "sound_walk": {
        "label": "Sound Walk",
        "stride_hz": 2.0,
        "duty": 0.64,
        "head": {"dc": 12.0, "a1": 0.22, "a2": 5.4, "phi1": 0.2, "phi2": 0.9},
        "pelvis": {"dc": 9.0, "a1": 0.20, "a2": 4.8, "phi1": 2.4, "phi2": 1.1},
        "lame_limb": None,
    },
    "sound_trot": {
        "label": "Sound Trot",
        "stride_hz": 2.9,
        "duty": 0.42,
        "head": {"dc": 14.0, "a1": 0.32, "a2": 6.8, "phi1": 0.1, "phi2": 0.4},
        "pelvis": {"dc": 10.0, "a1": 0.28, "a2": 6.1, "phi1": 2.7, "phi2": 0.8},
        "lame_limb": None,
    },
    "left_fore_3": {
        "label": "Left Forelimb Lameness grade 3",
        "stride_hz": 2.6,
        "duty": 0.36,
        "head": {"dc": 11.0, "a1": 1.9, "a2": 5.6, "phi1": 2.98, "phi2": 0.7},
        "pelvis": {"dc": 8.0, "a1": 0.22, "a2": 5.4, "phi1": 2.5, "phi2": 1.0},
        "lame_limb": "LF",
    },
    "right_hind_4": {
        "label": "Right Hindlimb Lameness grade 4",
        "stride_hz": 3.1,
        "duty": 0.33,
        "head": {"dc": 12.0, "a1": 0.30, "a2": 6.2, "phi1": 1.4, "phi2": 0.6},
        "pelvis": {"dc": 7.0, "a1": 3.2, "a2": 5.8, "phi1": 1.52, "phi2": 0.35},
        "lame_limb": "RH",
    },
    "bilateral_stifle": {
        "label": "Bilateral Stifle Disease bunny-hop",
        "stride_hz": 2.2,
        "duty": 0.50,
        "head": {"dc": 16.0, "a1": 1.2, "a2": 9.4, "phi1": 1.1, "phi2": 0.2},
        "pelvis": {"dc": 12.0, "a1": 2.4, "a2": 10.2, "phi1": 4.41, "phi2": 0.2},
        "lame_limb": "LH",
    },
}

AAHA_SCALE: tuple[dict[str, Any], ...] = (
    {"score": 0, "label": "Normal"},
    {"score": 1, "label": "Barely detectable"},
    {"score": 2, "label": "Mild weight-bearing"},
    {"score": 3, "label": "Moderate weight-bearing"},
    {"score": 4, "label": "Severe weight-bearing"},
    {"score": 5, "label": "Non-weight-bearing"},
)

# ---------------------------------------------------------------------------
# 1. Gait simulation & Fourier kinematics
# ---------------------------------------------------------------------------
def simulate_gait(
    profile_key: str = "left_fore_3",
    seconds: float = 6.0,
    fs: float = 120.0,
    seed: int = 0x9A17,
) -> dict[str, Any]:
    """Synthesise poll + tuber-sacrale vertical excursion (millimetres)."""
    profile = GAIT_PROFILES.get(profile_key, GAIT_PROFILES["sound_walk"])
    rng = random.Random(seed)
    n = int(seconds * fs)
    stride = profile["stride_hz"] * (1.0 + (rng.random() - 0.5) * 0.01)
    head: list[float] = []
    pelvis: list[float] = []
    for i in range(n):
        t = i / fs
        w = 2.0 * math.pi * stride
        hp = profile["head"]
        pp = profile["pelvis"]
        head.append(
            hp["dc"]
            + hp["a1"] * math.sin(w * t + hp["phi1"])
            + hp["a2"] * math.sin(2 * w * t + hp["phi2"])
            + 0.45 * math.sin(3 * w * t + 1.2)
            + (rng.random() - 0.5) * 0.55
            + 0.25 * math.sin(2 * math.pi * 0.21 * t)
        )
        pelvis.append(
            pp["dc"]
            + pp["a1"] * math.sin(w * t + pp["phi1"])
            + pp["a2"] * math.sin(2 * w * t + pp["phi2"])
            + 0.40 * math.sin(3 * w * t + 0.4)
            + (rng.random() - 0.5) * 0.50
            + 0.20 * math.sin(2 * math.pi * 0.17 * t + 1.3)
        )
    return {
        "profile": profile_key,
        "label": profile["label"],
        "stride_hz": stride,
        "fs": fs,
        "seconds": seconds,
        "head": head,
        "pelvis": pelvis,
    }


def fourier_coefficients(
    signal: Sequence[float],
    fs: float,
    base_freq: float,
    harmonics: int = 4,
) -> dict[str, Any]:
    """Hann-windowed DFT at integer multiples of the stride frequency."""
    n = len(signal)
    if n < 4:
        return {"dc": 0.0, "harmonics": [], "a1": 0.0, "a2": 0.0, "phi1": 0.0, "phi2": 0.0}

    window = [0.5 - 0.5 * math.cos(2.0 * math.pi * i / (n - 1)) for i in range(n)]
    wsum = sum(window) or 1e-9
    dc = sum(v * w for v, w in zip(signal, window)) / wsum

    out: list[dict[str, float]] = []
    for h in range(1, harmonics + 1):
        w = 2.0 * math.pi * base_freq * h
        re = 0.0
        im = 0.0
        for i in range(n):
            v = (signal[i] - dc) * window[i]
            re += v * math.cos(w * i / fs)
            im += v * math.sin(w * i / fs)
        amp = 2.0 * math.hypot(re, im) / wsum
        out.append(
            {
                "n": h,
                "amp": round(amp, 6),
                "phase": round(math.atan2(im, re), 6),
            }
        )
    a1 = out[0]["amp"] if out else 0.0
    a2 = out[1]["amp"] if len(out) > 1 else 0.0
    return {
        "dc": round(dc, 6),
        "harmonics": out,
        "a1": a1,
        "a2": a2,
        "phi1": out[0]["phase"] if out else 0.0,
        "phi2": out[1]["phase"] if len(out) > 1 else 0.0,
    }


def lameness_asymmetry_index(a1: float, a2: float) -> float:
    denom = a1 + a2
    return 0.0 if denom <= 1e-12 else (a1 / denom) * 100.0


def _circ_distance(a: float, b: float) -> float:
    d = abs(a - b) % 1.0
    return min(d, 1.0 - d)


def limb_phase_to_side(group: str, phase1: float) -> str:
    """Localise the lame limb from the first-harmonic phase.

    The nod / pelvic-hike peak lands roughly half a stride after the lame limb
    loads, so the phase is rotated by half a cycle and matched against each
    limb's contact phase (LF 0.00, RF 0.50, LH 0.25, RH 0.75).
    """
    cycle = ((math.pi / 2.0 - phase1) / (2.0 * math.pi)) % 1.0
    lame_phase = (cycle + 0.5) % 1.0
    if group == "fore":
        return "LF" if _circ_distance(lame_phase, 0.0) <= _circ_distance(lame_phase, 0.5) else "RF"
    return "LH" if _circ_distance(lame_phase, 0.25) <= _circ_distance(lame_phase, 0.75) else "RH"


def aaha_grade(lai: float) -> dict[str, Any]:
    if lai < 6:
        return dict(AAHA_SCALE[0])
    if lai < 12:
        return dict(AAHA_SCALE[1])
    if lai < 20:
        return dict(AAHA_SCALE[2])
    if lai < 30:
        return dict(AAHA_SCALE[3])
    if lai < 45:
        return dict(AAHA_SCALE[4])
    return dict(AAHA_SCALE[5])


def analyze_gait(
    profile_key: str = "left_fore_3",
    seconds: float = 6.0,
    fs: float = 120.0,
) -> dict[str, Any]:
    sim = simulate_gait(profile_key, seconds, fs)
    head_stats = fourier_coefficients(sim["head"], fs, sim["stride_hz"], 4)
    pelvis_stats = fourier_coefficients(sim["pelvis"], fs, sim["stride_hz"], 4)

    head_lai = lameness_asymmetry_index(head_stats["a1"], head_stats["a2"])
    pelvis_lai = lameness_asymmetry_index(pelvis_stats["a1"], pelvis_stats["a2"])
    dominant = "fore" if head_lai >= pelvis_lai else "hind"
    dominant_lai = max(head_lai, pelvis_lai)
    grade = aaha_grade(dominant_lai)
    dominant_phi1 = head_stats["phi1"] if dominant == "fore" else pelvis_stats["phi1"]
    phase_limb = None if dominant_lai < 6 else limb_phase_to_side(dominant, dominant_phi1)

    profile = GAIT_PROFILES.get(profile_key, GAIT_PROFILES["sound_walk"])
    return {
        "model_version": MODEL_VERSION,
        "profile": profile_key,
        "label": profile["label"],
        "stride_hz": round(sim["stride_hz"], 4),
        "head_lai_pct": round(head_lai, 3),
        "pelvis_lai_pct": round(pelvis_lai, 3),
        "dominant_limb_group": dominant,
        "dominant_lai_pct": round(dominant_lai, 3),
        "vector_sum_head_mm": round(math.hypot(head_stats["a1"], head_stats["a2"]), 3),
        "vector_sum_pelvis_mm": round(math.hypot(pelvis_stats["a1"], pelvis_stats["a2"]), 3),
        "aaha_score": grade["score"],
        "aaha_label": grade["label"],
        "lame_limb": profile["lame_limb"],
        "phase_limb": phase_limb,
        "phase_deg": round(math.degrees(dominant_phi1) % 360.0, 2),
        "harmonics": {"head": head_stats["harmonics"], "pelvis": pelvis_stats["harmonics"]},
    }


# ---------------------------------------------------------------------------
# 2. Acoustic feature extraction
# ---------------------------------------------------------------------------
def _is_power_of_two(n: int) -> bool:
    return n > 0 and (n & (n - 1)) == 0


def fft_in_place(re: list[float], im: list[float]) -> None:
    """Iterative radix-2 Cooley-Tukey FFT (in place)."""
    n = len(re)
    if n <= 1 or not _is_power_of_two(n):
        return
    j = 0
    for i in range(1, n):
        bit = n >> 1
        while j & bit:
            j ^= bit
            bit >>= 1
        j ^= bit
        if i < j:
            re[i], re[j] = re[j], re[i]
            im[i], im[j] = im[j], im[i]
    length = 2
    while length <= n:
        ang = -2.0 * math.pi / length
        wr = math.cos(ang)
        wi = math.sin(ang)
        for i in range(0, n, length):
            cr = 1.0
            ci = 0.0
            half = length >> 1
            for k in range(half):
                ur = re[i + k]
                ui = im[i + k]
                vr = re[i + k + half] * cr - im[i + k + half] * ci
                vi = re[i + k + half] * ci + im[i + k + half] * cr
                re[i + k] = ur + vr
                im[i + k] = ui + vi
                re[i + k + half] = ur - vr
                im[i + k + half] = ui - vi
                cr, ci = cr * wr - ci * wi, cr * wi + ci * wr
        length <<= 1


def _hann(n: int) -> list[float]:
    return [0.5 - 0.5 * math.cos(2.0 * math.pi * i / (n - 1)) for i in range(n)]


def band_energies(samples: Sequence[float], sr: float, fft_size: int = 4096) -> dict[str, float]:
    n = min(fft_size, len(samples))
    re = [0.0] * fft_size
    im = [0.0] * fft_size
    window = _hann(fft_size)
    for i in range(n):
        re[i] = samples[i] * window[i]
    fft_in_place(re, im)
    bands = {
        "sub": (18.0, 80.0),
        "low": (80.0, 280.0),
        "mid": (280.0, 900.0),
        "high": (900.0, 2400.0),
        "top": (2400.0, 6000.0),
    }
    sums = {k: 0.0 for k in bands}
    total = 0.0
    bin_hz = sr / fft_size
    for i in range(1, fft_size // 2):
        f = i * bin_hz
        p = re[i] * re[i] + im[i] * im[i]
        total += p
        for key, (lo, hi) in bands.items():
            if lo <= f < hi:
                sums[key] += p
    out = {"total": total}
    out.update(sums)
    out["stertor_energy"] = sums["low"] + sums["sub"] * 0.6
    out["stridor_energy"] = sums["high"] + sums["top"] * 0.35
    return out


def estimate_f0(samples: Sequence[float], sr: float, min_hz: float = 18.0, max_hz: float = 2600.0) -> float:
    """Autocorrelation pitch estimate on a decimated copy of the signal."""
    decim = max(1, int(sr / 4000.0))
    ds = [samples[i] for i in range(0, len(samples), decim)]
    dsr = sr / decim
    n = len(ds)
    if n < 32:
        return 0.0
    energy = sum(v * v for v in ds) / n
    if energy <= 1e-9:
        return 0.0
    min_lag = max(2, int(dsr / max_hz))
    max_lag = min(n - 2, int(dsr / min_hz))
    best_lag = min_lag
    best = -1.0
    for lag in range(min_lag, max_lag + 1):
        acc = 0.0
        for i in range(0, n - lag):
            acc += ds[i] * ds[i + lag]
        acc /= n - lag
        if acc > best:
            best = acc
            best_lag = lag
    return dsr / max(1, best_lag)


def _autocorr_clarity(samples: Sequence[float], sr: float, min_hz: float = 18.0, max_hz: float = 2600.0) -> float:
    """Normalised ACF peak (0–1) — the harmonic-to-noise input, mirrors the JS engine."""
    decim = max(1, int(sr / 4000.0))
    dsr = sr / decim
    n = len(samples) // decim
    if n < 32:
        return 0.0
    ds = [samples[i * decim] for i in range(n)]
    energy = sum(v * v for v in ds) / n
    if energy <= 1e-9:
        return 0.0
    min_lag = max(2, int(dsr / max_hz))
    max_lag = min(n - 2, int(dsr / min_hz))
    best = 0.0
    for lag in range(min_lag, max_lag + 1):
        acc = 0.0
        for i in range(0, n - lag):
            acc += ds[i] * ds[i + lag]
        acc /= n - lag
        if acc > best:
            best = acc
    return max(0.0, min(1.0, best / max(1e-9, energy)))


def harmonic_to_noise(samples: Sequence[float], sr: float) -> float:
    clarity = _autocorr_clarity(samples, sr)
    hnr = 10.0 * math.log10(max(1e-4, clarity) / max(1e-4, 1.0 - clarity))
    return max(-12.0, min(34.0, hnr))


def _median(values: list[float], win: int) -> list[float]:
    half = win // 2
    n = len(values)
    out = [0.0] * n
    for i in range(n):
        window = sorted(values[max(0, i - half) : min(n, i + half + 1)])
        out[i] = window[len(window) // 2]
    return out


def _quantile(sorted_values: list[float], pct: float) -> float:
    if not sorted_values:
        return 0.0
    idx = min(len(sorted_values) - 1, int(pct * len(sorted_values)))
    return sorted_values[idx]


def _burst_statistics(samples: Sequence[float], sr: float) -> dict[str, float]:
    frame = max(24, int(round(sr * 0.008)))
    frames = max(1, len(samples) // frame)
    raw: list[float] = []
    for i in range(frames):
        chunk = samples[i * frame : (i + 1) * frame]
        acc = 0.0
        for v in chunk:
            acc += v * v
        raw.append(math.sqrt(acc / max(1, len(chunk))))
    env = _median(raw, max(3, int(round((0.12 * sr) / frame)) | 1))
    env_fast = _median(raw, max(3, int(round((0.048 * sr) / frame)) | 1))

    srt = sorted(env)
    floor = _quantile(srt, 0.2)
    peak = _quantile(srt, 0.97)
    srt_fast = sorted(env_fast)
    lo_fast = _quantile(srt_fast, 0.2)
    hi_fast = _quantile(srt_fast, 0.97)
    hi = lo_fast + (hi_fast - lo_fast) * 0.5
    lo = lo_fast + (hi_fast - lo_fast) * 0.2

    gate = max(floor, peak * 0.32)
    duty = sum(1 for v in env if v >= gate)

    frame_rate = sr / frame
    min_gap = max(1, int(round(frame_rate * 0.07)))
    onsets = 0
    armed = True
    armed_level = 0.0
    last_onset = -min_gap
    for i, v in enumerate(env_fast):
        if v < lo:
            armed = True
            armed_level = v
            continue
        if not armed or v < hi:
            continue
        if v < armed_level * 1.9:
            continue
        if i - last_onset < min_gap:
            continue
        onsets += 1
        last_onset = i
        armed = False

    duration = max(1e-6, len(samples) / sr)
    return {
        "burst_rate": onsets / max(0.2, duration),
        "duty_factor": duty / max(1, len(env)),
        "frames": frames,
    }


def extract_features(samples: Sequence[float], sr: float = 24000.0) -> dict[str, float]:
    bands = band_energies(samples, sr)
    total = max(1e-9, bands["total"])
    f0 = estimate_f0(samples, sr)

    # spectral centroid over a 2048-point FFT
    fft_size = 2048
    re = [0.0] * fft_size
    im = [0.0] * fft_size
    window = _hann(fft_size)
    n = min(fft_size, len(samples))
    for i in range(n):
        re[i] = samples[i] * window[i]
    fft_in_place(re, im)
    num = 0.0
    den = 0.0
    bin_hz = sr / fft_size
    for i in range(1, fft_size // 2):
        mag = math.hypot(re[i], im[i])
        num += mag * i * bin_hz
        den += mag
    centroid = num / den if den > 1e-9 else 0.0

    # Burst statistics: 8 ms RMS frames, median-smoothed over 120 ms (duty) and
    # 48 ms (onsets) — mirrors the browser engine so both agree on the same clip.
    burst = _burst_statistics(samples, sr)
    duration = max(1e-6, len(samples) / sr)

    return {
        "f0_hz": round(f0, 3),
        "centroid_hz": round(centroid, 2),
        "hnr": round(harmonic_to_noise(samples, sr), 2),
        "burst_rate_hz": round(burst["burst_rate"], 3),
        "duty_factor": round(burst["duty_factor"], 4),
        "low_ratio": round(bands["low"] / total, 4),
        "mid_ratio": round(bands["mid"] / total, 4),
        "high_ratio": round(bands["high"] / total, 4),
        "stertor_ratio": round(bands["stertor_energy"] / total, 4),
        "stridor_ratio": round(bands["stridor_energy"] / total, 4),
        "duration_s": round(duration, 3),
        "sample_rate": sr,
    }


# ---------------------------------------------------------------------------
# 3. Respiratory signature classification
# ---------------------------------------------------------------------------
SIGNATURES: tuple[dict[str, Any], ...] = (
    {"key": "purr", "label": "Feline Purr", "species": "cat", "f0": (20, 34), "centroid": (400, 820), "burst": (0.05, 0.5), "duty": (0.6, 1.0), "low": (0.08, 0.25)},
    {"key": "kennel_cough", "label": "Kennel Cough", "species": "dog", "f0": (265, 410), "centroid": (560, 790), "burst": (2.2, 4.4), "duty": (0.22, 0.44), "low": (0.04, 0.13)},
    {"key": "reverse_sneeze", "label": "Reverse Sneeze", "species": "dog", "f0": (345, 540), "centroid": (390, 620), "burst": (3.4, 7.2), "duty": (0.3, 0.6), "low": (0.03, 0.12)},
    {"key": "boas_stertor", "label": "BOAS Stertor", "species": "dog", "f0": (1000, 2400), "centroid": (130, 260), "burst": (0.5, 1.4), "duty": (0.45, 0.85), "low": (0.85, 1.0)},
    {"key": "boas_stridor", "label": "BOAS Stridor", "species": "dog", "f0": (700, 1400), "centroid": (1150, 2000), "burst": (0.5, 1.4), "duty": (0.5, 0.9), "low": (0.0, 0.07)},
    {"key": "feline_wheeze", "label": "Feline Asthma Wheeze", "species": "cat", "f0": (570, 1050), "centroid": (900, 1550), "burst": (0.7, 1.7), "duty": (0.45, 0.85), "low": (0.0, 0.07)},
    {"key": "goose_honk", "label": "Off-target Goose Honk", "species": "any", "f0": (380, 660), "centroid": (1500, 2500), "burst": (0.4, 1.1), "duty": (0.08, 0.28), "low": (0.02, 0.1)},
)

def _membership(value: float, lo: float, hi: float, slack: float = 0.55) -> float:
    if value is None or not math.isfinite(value):
        return 0.0
    if lo <= value <= hi:
        return 1.0
    span = max(1e-9, hi - lo)
    pad = span * slack
    if value < lo:
        return max(0.0, 1.0 - (lo - value) / pad)
    return max(0.0, 1.0 - (value - hi) / pad)


def classify_signature(features: dict[str, float], species: str = "dog") -> list[dict[str, Any]]:
    scored: list[dict[str, Any]] = []
    for sig in SIGNATURES:
        parts = [
            _membership(features["f0_hz"], sig["f0"][0] * 0.65, sig["f0"][1] * 1.6),
            _membership(features["centroid_hz"], sig["centroid"][0] * 0.6, sig["centroid"][1] * 1.7),
            _membership(features["burst_rate_hz"], sig["burst"][0] * 0.6, sig["burst"][1] * 1.6),
            _membership(features["duty_factor"], sig["duty"][0] * 0.6, min(1.0, sig["duty"][1] * 1.25)),
            _membership(features["low_ratio"], sig["low"][0] * 0.6, min(1.0, sig["low"][1] * 1.5)),
        ]
        score = sum(parts) / len(parts)
        if sig["species"] == species:
            score *= 1.32
        elif sig["species"] == "any":
            score *= 0.92
        else:
            score *= 0.62
        if sig["key"] == "purr" and features["f0_hz"] > 60:
            score *= 0.08
        if sig["key"] == "purr" and features["low_ratio"] < 0.1:
            score *= 0.45
        if sig["key"] == "kennel_cough" and features["burst_rate_hz"] > 4.2:
            score *= 0.45
        if sig["key"] == "kennel_cough" and features["centroid_hz"] < 550:
            score *= 0.35
        if sig["key"] == "reverse_sneeze" and features["burst_rate_hz"] < 2.6:
            score *= 0.45
        if sig["key"] == "reverse_sneeze" and features["centroid_hz"] > 700:
            score *= 0.4
        if sig["key"] == "reverse_sneeze" and features["hnr"] > 8:
            score *= 0.5
        if sig["key"] == "boas_stertor" and features["centroid_hz"] > 500:
            score *= 0.15
        if sig["key"] == "boas_stridor" and features["centroid_hz"] < 800:
            score *= 0.2
        if sig["key"] == "goose_honk" and features["duty_factor"] > 0.5:
            score *= 0.45
        scored.append({"key": sig["key"], "label": sig["label"], "score": max(0.0, score)})

    total = sum(max(0.0, s["score"]) ** 3.2 for s in scored) or 1.0
    for s in scored:
        s["confidence_pct"] = round((max(0.0, s["score"]) ** 3.2 / total) * 100.0, 2)
        s.pop("score", None)
    scored.sort(key=lambda x: x["confidence_pct"], reverse=True)
    return scored


def compute_boas(features: dict[str, float]) -> dict[str, Any]:
    stertor = features["stertor_ratio"]
    stridor = features["stridor_ratio"]
    asoi = (stridor / max(1e-9, stridor + stertor)) * 100.0
    severity = min(100.0, asoi * 0.62 + features["duty_factor"] * 100.0 * 0.34)
    grade = 3 if severity >= 62 else 2 if severity >= 42 else 1 if severity >= 22 else 0
    labels = {
        0: "Grade 0 - Clinically normal",
        1: "Grade I - Mild obstruction",
        2: "Grade II - Moderate obstruction",
        3: "Grade III - Severe obstruction",
    }
    return {
        "asoi_pct": round(asoi, 2),
        "severity": round(severity, 2),
        "grade": grade,
        "label": labels[grade],
    }


def analyze_acoustic(features: dict[str, float], species: str = "dog") -> dict[str, Any]:
    ranked = classify_signature(features, species)
    # The BOAS index is a brachycephalic-dog score (stertor:stridor ratio); it is
    # not defined for cats or for the off-target control signature.
    dog_like = species == "dog"
    return {
        "model_version": MODEL_VERSION,
        "species": species,
        "features": features,
        "ranking": ranked,
        "top_match": ranked[0] if ranked else None,
        "boas": compute_boas(features) if dog_like else None,
        "boas_applicable": dog_like,
        "boas_note": None
        if dog_like
        else "BOAS grading applies to brachycephalic dogs only — not scored for this species.",
    }


def summarize(value: Iterable[float]) -> dict[str, float]:
    data = [float(v) for v in value]
    if not data:
        return {"mean": 0.0, "min": 0.0, "max": 0.0}
    return {
        "mean": round(sum(data) / len(data), 4),
        "min": round(min(data), 4),
        "max": round(max(data), 4),
    }


# Silence unused-import lint noise for cmath in environments without type tools.
_ = cmath
