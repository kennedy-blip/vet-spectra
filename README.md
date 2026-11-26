# VET-SPECTRA

A field veterinary clinical workstation that runs **entirely in the browser** — five
diagnostic modules, a WebGL macro lens, a WebAudio/IMU signal lab and an
IndexedDB record vault — plus a stateless Python physics API that re-derives the
same maths server-side.

Everything is zero-TypeScript: `.js` + `.svelte` only, Svelte 4 syntax, no CDN or
remote asset of any kind (the preview runs with no network).

```
src/
  lib/engines/        5 clinical engines (pure ES modules, no DOM)
  lib/components/     workstation shell, dock, modals
  lib/components/modules/   the five modules
  lib/db/             IndexedDB vault + sync outbox
  lib/selftests/      the 16-assertion suite the admin console runs
  lib/gl/, shaders/    WebGL macro lens (GLSL via ?raw)
  routes/             SvelteKit SPA shell
python_vet/           Python mirrors of the toxicology + gait/acoustic engines
server/vet_physics.py stdlib HTTP server (local) / api/index.py WSGI (Vercel)
android/              Capacitor 6 host + two Kotlin sensor plugins
```

## Modules

| # | Module | Engine highlights |
|---|--------|-------------------|
| 1 | Toxicology Kinetic Shield | Bateman PK with enterohepatic recirculation, 9 chocolate/coffee matrices, MDR1 screen, Kleiber RER, fluid plan |
| 2 | Bioacoustic Lab | STFT waterfall, band energies, pitch/cepstrum/HNR features, 7-signature differential, BOAS stertor:stridor grade |
| 3 | Quadruped Gait Scanner | Poll/tuber-sacrale Fourier harmonics, Lameness Asymmetry Index, phase-based limb localisation, AAHA grade, CSU pain score |
| 4 | Cardio-Pulmonary ACVIM Lab | PCG synthesis, Shannon-energy S1/S2 segmentation, SMER → Levine I–VI, SCG thrill lift, RSA/HRV, ACVIM SRR staging |
| 5 | Tick Vector Derma Auditor | WebGL macro lens + Sobel/false-colour, scutal index → attachment hours → transmission windows, CIELAB gingiva + CRT, quote auditor |

Keyboard: `1`–`5` switch modules, `Esc` closes any modal. The ⚙ dock button opens
the Polyglot Admin Console (self-tests · Python API probe · vault · stack/RBAC).

## Run

```bash
npm ci
npm run dev            # http://localhost:5173
npm run build && npm run preview   # http://localhost:4173
```

Optional Python API (the Vite dev/preview server proxies `/api` → `:8099`):

```bash
python3 server/vet_physics.py     # http://0.0.0.0:8099/api/vet_physics
```

## Verify

```bash
npm test                      # 16 in-browser engine assertions, browserless
npm run test:py               # Python mirrors through the same API router
npm run build                 # adapter-static → build/

python3 -m compileall -q python_vet server api
curl -s localhost:8099/api/vet_physics
curl -s -X POST localhost:8099/api/vet_physics \
  -H 'content-type: application/json' \
  -d '{"action":"dose","weight_kg":12,"mass_g":85,"matrix_key":"dark70","species":"dog"}'
```

Reference numbers both engines must agree on:

| Check | Value |
|-------|-------|
| 85 g 70 % dark chocolate ÷ 12 kg dog | `53.83 mg/kg` → zone `cardio` |
| Kleiber RER at 12 kg | `451.3 kcal/d` |
| Fluid deficit 12 kg @ 5 % | `600 mL` + `851 mL` maintenance |
| Gait `sound_trot` | LAI `4.5 %`, AAHA 0, no limb claimed |
| Gait `left_fore_3` | LAI `25 %`, phase limb `LF`, AAHA 3 |
| PCG `normal` / `mmvd` | SMER `0.4 %` grade I / `18 %` grade V + thrill |
| Scutal index 8.2 ÷ 3.6 mm | `57.3 h` attached → Lyme band |
| Quote `dental` $1200 with duplicated anesthesia | `duplicate` + `unbundling` flags |

## Production smoke

`production-smoke.yml` probes the *deployed* site instead of the build:

```bash
gh workflow run production-smoke.yml                      # default https://vet-spectra.vercel.app
gh workflow run production-smoke.yml -f base_url=https://<preview>.vercel.app
```

It asserts `GET /` → 200 with the app title, `GET /api/vet_physics` →
`27.0.0-polyglot` with `"engines":5`, `HEAD /releases/vet-spectra-v27.0.0.apk` →
`30x` pointing at the GitHub latest release, and the followed download → `200`,
> 1 MB, `PK` header. Every probe is printed, added to the job summary and
uploaded as the `smoke-report` artifact, so a red run says which hop broke.
Last run against production: green (`success`, 9 s).

## API

Every action answers a flat JSON envelope `{ ok, action, result }`
(`GET /` returns the health payload directly, for probes).

| Action | Body | Result |
|--------|------|--------|
| `health` | — | version, runtime, engine counts |
| `dose` | `weight_kg, mass_g, matrix_key, species, minutes_since_ingestion` | 96-point PK curve, zone, decontamination windows, fluids |
| `gait` | `profile` | LAI per pelvis, dominant group, `lame_limb`, `phase_limb`, AAHA grade |
| `acoustic` | `features{f0_hz, centroid_hz, hnr, …}, species` | ranked differential + BOAS (dogs only) |
| `quote` | `procedure, quoted_total, region, line_items` | fair range, verdict, duplicate/unbundling/markup flags, insurance split |
| `sync` | `store, payload, client_ts` | sha-256 envelope receipt |

Sync is append-only and stateless: the phone's IndexedDB copy stays authoritative,
the server only confirms and archives.

## Android

`capacitor.config.json` points at `build/`; `android/app/src/main/java/com/vetspectra/plugins/`
holds the two native bridges the web layer expects:

- `VetRawAcousticImu` — 16-bit PCM frames + accelerometer/gyroscope samples over
  Capacitor events, so all DSP still happens in the shared ES modules.
- `VetMacroCameraTorch` — torch level control and lens facts (focal length, minimum
  focus distance, zoom range) for the macro lens HUD.

`.github/workflows/build-and-bundle-apk.yml` has two jobs:

1. **Engines & web bundle** — `npm test` (16 assertions), `scripts/check-engines.py`
   (JS↔Python parity), `npm run build`, artifact upload.
2. **Release APK** — downloads that bundle, runs `npx cap copy android`
   (web assets + `capacitor.config.json` land in `android/app/src/main/assets/`),
   assembles the APK, verifies it is a real zip containing `classes.dex`, uploads
   `vet-spectra-v27.0.0.apk`, and attaches it to the GitHub release on a `v*` tag.

### Release signing

The APK task is chosen by the `Configure APK signing` step:

| secret | meaning |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0` of the keystore (`.p12`/`.jks`) |
| `ANDROID_KEYSTORE_PASSWORD` | store password |
| `ANDROID_KEY_ALIAS` | key alias, currently `vet-spectra` |
| `ANDROID_KEY_PASSWORD` | key password (equal to the store password for PKCS12) |

All four present → `gradle assembleRelease`, then `apksigner verify --print-certs`
and the job fails if the certificate still says `CN=Android Debug`. Any of them
missing → `gradle assembleDebug`, so a fork or a fresh clone still produces an
installable APK. The keystore is never committed: it is git-ignored under
`android/signing-backup/` (with the password and the certificate fingerprint in
`CREDENTIALS.txt`); add it to the repository secrets to switch signing on.

```bash
gh secret set ANDROID_KEYSTORE_BASE64 --body "$(base64 -w0 android/signing-backup/vet-spectra-release.p12)"
gh secret set ANDROID_KEYSTORE_PASSWORD --body '<store password>'
gh secret set ANDROID_KEY_ALIAS --body 'vet-spectra'
gh secret set ANDROID_KEY_PASSWORD --body '<key password>'
```

Tagging is what publishes: `git tag v27.0.0 && git push origin v27.0.0` builds the
APK and creates the `v27.0.0` GitHub release with the asset attached (the workflow
needs `permissions: contents: write` for that step).

The download route `/releases/vet-spectra-v27.0.0.apk` is redirected by
`vercel.json` to `releases/latest/download/vet-spectra-v27.0.0.apk`, so the QR code
and the download button always serve the newest release APK. If no release exists
(or the device is offline) the modal falls back to the in-browser replica build.

## Deploy (Vercel)

Live production: **https://vet-spectra.vercel.app** (project `vet-spectra`, team
`kmokaya864-5310`, framework *svelte*, build `npm run build`, output `build`,
install `npm ci`, production branch `main`).

`vercel.json` builds `npm run build` into `build/`, rewrites SPA routes to
`index.html`, proxies `/api/vet_physics` to the Python WSGI entry point
(`api/index.py`) and sets immutable caching for hashed assets.

Two things matter for the Python function:

- `api/` must contain **only** the entry point — Vercel turns every `.py` under it
  into a function, so the router lives in `server/vet_physics.py` and `api/index.py`
  imports it statically (the tracer follows imports, not `importlib` loads).
- `vercel.json` routes `/api/vet_physics` to `/api/index`; anything else under
  `/api` is not rewritten.

```bash
curl -s https://vet-spectra.vercel.app/api/vet_physics   # {"ok":true,...,"version":"27.0.0-polyglot"}
curl -sI https://vet-spectra.vercel.app/releases/vet-spectra-v27.0.0.apk   # 307 -> releases/latest/download/...
```

## Notes

- The vault is offline-first; the sync outbox retries when the API is reachable and
  the UI states clearly when it is not.
- No audio ever autoplays: every playback path starts from an explicit user gesture.
- Clinical scoring is intentionally conservative — below the 6 % LAI threshold no
  lame limb is claimed, and BOAS is never scored for cats.
