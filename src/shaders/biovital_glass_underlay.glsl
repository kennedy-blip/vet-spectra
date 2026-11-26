#version 300 es
/*
 * VET-SPECTRA · biovital_glass_underlay.glsl
 * ---------------------------------------------------------------------------
 * Full-screen living-glass backdrop: domain-warped metaball clinical field,
 * travelling ECG waveform locked to the patient heart rate, a slow respiratory
 * sine, toxicology hazard bloom, dispersion-vignette and film grain.
 *
 * Uniform contract (set from src/lib/gl/biovitalUnderlay.js)
 *   u_resolution : vec2  device pixels
 *   u_time       : float seconds since mount
 *   u_theme      : float 0 obsidian | 1 daylight | 2 nocturnal | 3 eco
 *   u_energy     : float 0..1 live audio RMS (bio-acoustic lab)
 *   u_toxicity   : float 0..1 serum methylxanthine load (toxicology lab)
 *   u_hr         : float heart rate bpm
 *   u_eco        : float 1.0 when Eco-Glass is active (octave / LOD cap)
 * ---------------------------------------------------------------------------
 */
precision highp float;

out vec4 fragColor;

uniform vec2 u_resolution;
uniform float u_time;
uniform float u_theme;
uniform float u_energy;
uniform float u_toxicity;
uniform float u_hr;
uniform float u_eco;

#define PI 3.141592653589793
#define TAU 6.283185307179586

float hash21(vec2 p) {
	p = fract(p * vec2(127.1, 311.7));
	p += dot(p, p + 34.23);
	return fract(p.x * p.y);
}

float vnoise(vec2 p) {
	vec2 i = floor(p);
	vec2 f = fract(p);
	vec2 u = f * f * (3.0 - 2.0 * f);
	float a = hash21(i);
	float b = hash21(i + vec2(1.0, 0.0));
	float c = hash21(i + vec2(0.0, 1.0));
	float d = hash21(i + vec2(1.0, 1.0));
	return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
	float v = 0.0;
	float amp = 0.55;
	mat2 rot = mat2(0.82, 0.57, -0.57, 0.82);
	for (int i = 0; i < 5; i++) {
		v += amp * vnoise(p);
		p = rot * p * 2.03 + 11.7;
		amp *= 0.5;
		if (i >= 2 && u_eco > 0.5) break;
	}
	return v;
}

float metaball(vec2 p, vec2 centre, float radius) {
	vec2 d = p - centre;
	return (radius * radius) / max(1e-4, dot(d, d));
}

/* Single-lead ECG as a function of cycle phase 0..1 */
float ecgWave(float phase) {
	float v = 0.0;
	v += exp(-pow((phase - 0.14) / 0.022, 2.0)) * 0.16;
	v += exp(-pow((phase - 0.225) / 0.008, 2.0)) * -0.30;
	v += exp(-pow((phase - 0.248) / 0.009, 2.0)) * 1.00;
	v += exp(-pow((phase - 0.272) / 0.013, 2.0)) * -0.34;
	v += exp(-pow((phase - 0.52) / 0.052, 2.0)) * 0.22;
	v += exp(-pow((phase - 0.72) / 0.10, 2.0)) * 0.06;
	return v;
}

void main() {
	vec2 res = u_resolution;
	vec2 uv = (gl_FragCoord.xy - 0.5 * res) / min(res.x, res.y);
	float t = u_time;
	float eco = u_eco > 0.5 ? 1.0 : 0.0;

	/* ---- theme palette ------------------------------------------------ */
	vec3 bgA = vec3(0.020, 0.043, 0.082);
	vec3 bgB = vec3(0.006, 0.012, 0.030);
	vec3 colA = vec3(0.063, 0.725, 0.506); /* teal    */
	vec3 colB = vec3(0.024, 0.714, 0.827); /* cyan    */
	vec3 colC = vec3(0.957, 0.247, 0.369); /* coral   */
	vec3 colD = vec3(0.545, 0.361, 0.965); /* violet  */
	float dark = 1.0;

	if (u_theme > 0.5 && u_theme < 1.5) {
		bgA = vec3(0.930, 0.950, 0.972);
		bgB = vec3(0.972, 0.980, 0.990);
		colA = vec3(0.011, 0.518, 0.404);
		colB = vec3(0.016, 0.518, 0.780);
		colC = vec3(0.882, 0.114, 0.282);
		colD = vec3(0.427, 0.157, 0.851);
		dark = 0.0;
	} else if (u_theme > 1.5 && u_theme < 2.5) {
		bgA = vec3(0.043, 0.012, 0.012);
		bgB = vec3(0.016, 0.004, 0.004);
		colA = vec3(0.851, 0.467, 0.024);
		colB = vec3(0.639, 0.145, 0.055);
		colC = vec3(0.737, 0.114, 0.235);
		colD = vec3(0.545, 0.086, 0.129);
	} else if (u_theme > 2.5) {
		bgA = vec3(0.051, 0.086, 0.141);
		bgB = vec3(0.043, 0.071, 0.118);
		colA = vec3(0.059, 0.463, 0.431);
		colB = vec3(0.082, 0.369, 0.459);
		colC = vec3(0.498, 0.114, 0.114);
		colD = vec3(0.216, 0.188, 0.639);
	}

	/* ---- domain-warped metaball field -------------------------------- */
	vec2 p = uv;
	float breath = sin(t * 0.42) * 0.5 + 0.5;
	float rx = cos(t * 0.13) * 0.30;
	float ry = sin(t * 0.17) * 0.22;

	vec2 w1 = vec2(
		fbm(p * 1.25 + vec2(t * 0.035, 0.0)) - 0.5,
		fbm(p * 1.25 + vec2(0.0, t * 0.031) + 4.2) - 0.5
	);
	vec2 q = p + w1 * (0.34 + 0.10 * breath);

	float field = 0.0;
	field += metaball(q, vec2(-0.46 + rx, 0.30 + ry * 0.7), 0.30 + 0.06 * breath);
	field += metaball(q, vec2(0.52 - rx * 0.8, -0.26 - ry), 0.27 + 0.05 * sin(t * 0.37));
	field += metaball(q, vec2(0.14 + rx * 0.5, 0.58 + ry * 0.4), 0.21);
	field *= 0.42;

	float iso = smoothstep(0.55, 1.55, field);
	float rim = smoothstep(0.42, 0.62, field) - smoothstep(0.62, 1.05, field);
	float aura = exp(-2.4 * abs(field - 0.72));

	vec3 col = mix(bgB, bgA, smoothstep(0.0, 1.05, length(uv * vec2(0.85, 1.15))));
	col += mix(colA, colB, smoothstep(0.25, 0.85, field)) * iso * (0.30 + 0.22 * u_energy);
	col += colB * rim * (0.28 + 0.35 * u_energy);
	col += mix(colC, colD, 0.5 + 0.5 * sin(t * 0.21)) * aura * 0.10;
	col = mix(col, col * (1.0 + u_toxicity * 0.55) + colC * u_toxicity * 0.12, 0.85);

	/* ---- travelling ECG trace ---------------------------------------- */
	float hr = clamp(u_hr, 40.0, 240.0);
	float beatPhase = fract(t * (hr / 60.0));
	float lineY = -0.30 + 0.045 * sin(t * 0.31);
	float xNorm = uv.x * 0.75 + 0.5;
	float phaseAtX = fract(xNorm - t * (hr / 60.0) * 0.08);
	float ecg = ecgWave(phaseAtX) * 0.075;
	float d = abs(uv.y - lineY - ecg);
	float trace = exp(-d * 170.0);
	float traceGlow = exp(-d * 26.0);
	col += mix(colB, colA, 0.45) * trace * 0.85;
	col += colB * traceGlow * 0.12;

	/* ---- slow respiratory sine --------------------------------------- */
	float respY = 0.34 + 0.030 * sin(uv.x * 4.2 + t * 0.9);
	float dr = abs(uv.y - respY);
	col += colA * exp(-dr * 130.0) * 0.16;

	/* ---- dispersion vignette + reticle ------------------------------- */
	float vig = 1.0 - smoothstep(0.55, 1.55, length(uv * vec2(1.0, 1.12)));
	col *= mix(0.55, 1.0, vig);

	float ringR = 0.72 + 0.008 * sin(t * 0.7);
	float ring = exp(-pow((length(uv) - ringR) / 0.006, 2.0));
	col += colB * ring * 0.10;

	/* fine bio-grid */
	vec2 grid = abs(fract(uv * 26.0) - 0.5);
	float gridLine = smoothstep(0.47, 0.5, max(grid.x, grid.y)) * 0.035;
	col += colA * gridLine * (1.0 - eco * 0.7);

	/* ---- film grain + dither ----------------------------------------- */
	float grain = hash21(gl_FragCoord.xy + fract(t) * 731.0);
	col += (grain - 0.5) * (0.020 + 0.012 * dark);

	/* gentle ACES-ish shoulder */
	col = col / (col + 0.78);
	col = pow(col, vec3(0.92));

	fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
