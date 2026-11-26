"""
VET-SPECTRA · python_vet
===========================================================================
Server-side mirrors of the four clinical mathematics engines that power the
VET-SPECTRA workstation. They are byte-for-byte equivalent in behaviour to the
ES2024 modules under ``src/lib/engines`` so a record can be re-derived on the
server after an offline capture.

Modules
-------
toxicology_allometry_solver
    Methylxanthine Bateman pharmacokinetics, multi-toxin emergency thresholds,
    Kleiber allometry (RER = 70·W^0.75) and 24 h fluid therapy.
quadruped_gait_acoustic_biometrics
    Fourier lameness kinematics (LAI = A1/(A1+A2)) plus the acoustic feature
    extractor / respiratory-signature classifier used by the airway lab.

Design constraints
------------------
* Python 3.12 standard library only — no numpy, no scipy, no pandas.
* Deterministic: every routine is pure and seeded, so the same payload yields
  the same numbers on the phone, the browser and the serverless function.
* No PHP. No TypeScript.
"""

from __future__ import annotations

__all__ = [
    "toxicology_allometry_solver",
    "quadruped_gait_acoustic_biometrics",
]

__version__ = "27.0.0-polyglot"
__model__ = "vet-spectra/server-27.0.0"
