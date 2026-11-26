#version 300 es
/*
 * VET-SPECTRA · tick_gingival_macro_lens.glsl
 * ---------------------------------------------------------------------------
 * Macro-lens compositor for the tick scutum / gingival mucosa camera.
 *
 *   • Radial macro magnification with barrel distortion
 *   • Chromatic aberration proportional to field curvature
 *   • 3×3 Sobel scutum-margin edge extraction (cyan overlay)
 *   • Ring-light specular glint + surgical-field vignette
 *   • False-colour perfusion ramp (mode 1) and redness index boost
 *   • Millimetre graticule + reticle + rolling scan sweep
 *
 * Uniform contract (set from src/lib/components/modules/TickVectorDermaAuditor)
 *   u_tex        sampler2D  live camera / procedural specimen
 *   u_resolution vec2
 *   u_time       float      seconds
 *   u_zoom       float      1.0 – 4.0
 *   u_edge       float      0.0 – 1.0 edge overlay gain
 *   u_mode       float      0 tick scutum | 1 gingival mucosa
 *   u_falseColor float      0 off | 1 perfusion ramp
 *   u_uvOffset   vec2       pan
 * ---------------------------------------------------------------------------
 */
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D u_tex;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_zoom;
uniform float u_edge;
uniform float u_mode;
uniform float u_falseColor;
uniform vec2 u_uvOffset;

float luma(vec3 c) {
	return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

vec3 viridis(float t) {
	t = clamp(t, 0.0, 1.0);
	vec3 c0 = vec3(0.267, 0.005, 0.329);
	vec3 c1 = vec3(0.188, 0.407, 0.554);
	vec3 c2 = vec3(0.208, 0.718, 0.472);
	vec3 c3 = vec3(0.993, 0.906, 0.144);
	if (t < 0.34) return mix(c0, c1, t / 0.34);
	if (t < 0.67) return mix(c1, c2, (t - 0.34) / 0.33);
	return mix(c2, c3, (t - 0.67) / 0.33);
}

vec3 sampleTex(vec2 uv) {
	return texture(u_tex, clamp(uv, vec2(0.001), vec2(0.999))).rgb;
}

void main() {
	vec2 res = u_resolution;
	vec2 aspect = vec2(res.x / res.y, 1.0);
	vec2 c = (vUv - 0.5) * aspect;
	float r2 = dot(c, c);

	/* radial macro magnification with barrel distortion */
	vec2 macro = vUv + u_uvOffset * 0.5;
	vec2 warped = 0.5 + (macro - 0.5) * (1.0 - 0.22 * r2) / max(u_zoom, 0.75);

	/* chromatic aberration grows toward the field edge */
	float ca = (0.0011 + 0.0026 * r2) / max(u_zoom, 1.0);
	vec3 col;
	col.r = sampleTex(warped + c * ca).r;
	col.g = sampleTex(warped).g;
	col.b = sampleTex(warped - c * ca).b;

	/* ---- Sobel edge extraction on luminance -------------------------- */
	vec2 texel = 1.0 / max(res, vec2(1.0));
	float tl = luma(sampleTex(warped + texel * vec2(-1.0, 1.0)));
	float tc = luma(sampleTex(warped + texel * vec2(0.0, 1.0)));
	float tr = luma(sampleTex(warped + texel * vec2(1.0, 1.0)));
	float ml = luma(sampleTex(warped + texel * vec2(-1.0, 0.0)));
	float mr = luma(sampleTex(warped + texel * vec2(1.0, 0.0)));
	float bl = luma(sampleTex(warped + texel * vec2(-1.0, -1.0)));
	float bc = luma(sampleTex(warped + texel * vec2(0.0, -1.0)));
	float br = luma(sampleTex(warped + texel * vec2(1.0, -1.0)));

	float gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
	float gy = -bl - 2.0 * bc - br + tl + 2.0 * tc + tr;
	float edge = clamp(length(vec2(gx, gy)) * 1.9, 0.0, 1.0);
	vec3 edgeCol = mix(vec3(0.024, 0.714, 0.827), vec3(0.063, 0.725, 0.506), edge);
	col = mix(col, col * 0.35 + edgeCol, edge * u_edge * 0.85);

	/* ---- ring light + surgical vignette ------------------------------ */
	vec2 lightPos = vec2(-0.55, 0.62) + 0.05 * vec2(sin(u_time * 0.4), cos(u_time * 0.33));
	float spec = exp(-pow(length(c - lightPos) / 0.30, 2.0));
	col += vec3(1.0, 0.98, 0.94) * spec * (0.10 + 0.22 * edge);

	float vig = 1.0 - smoothstep(0.30, 1.05, length(c));
	col *= mix(0.42, 1.05, vig);

	/* ---- gingival / perfusion processing ----------------------------- */
	if (u_mode > 0.5) {
		float redness = col.r / max(1e-3, col.g + col.b);
		col = mix(col, vec3(1.0, 0.42, 0.48), clamp((redness - 0.55) * 1.35, 0.0, 0.42));
		col = mix(vec3(luma(col)), col, 1.35);
		if (u_falseColor > 0.5) {
			float perfusion = clamp(redness * 1.55, 0.0, 1.0);
			col = mix(viridis(perfusion) * (0.55 + 0.6 * luma(col)), col, 0.22);
		}
	} else if (u_falseColor > 0.5) {
		col = mix(viridis(luma(col)), col, 0.28);
	}

	/* ---- millimetre graticule + reticle ------------------------------ */
	vec2 mm = (vUv + u_uvOffset) * 10.0;
	vec2 gridD = abs(fract(mm) - 0.5);
	float major = smoothstep(0.485, 0.5, max(gridD.x, gridD.y));
	vec2 mm5 = (vUv + u_uvOffset) * 2.0;
	vec2 grid5 = abs(fract(mm5) - 0.5);
	float major5 = smoothstep(0.49, 0.5, max(grid5.x, grid5.y));
	col += vec3(0.55, 0.85, 0.95) * major * 0.045;
	col += vec3(0.65, 0.95, 1.0) * major5 * 0.10;

	vec2 rc = abs(vUv - 0.5);
	float cross = (exp(-rc.y * 900.0) + exp(-rc.x * 900.0)) * 0.13;
	cross *= step(0.5, max(rc.x, rc.y));
	col += vec3(0.4, 0.95, 1.0) * cross;

	float reticle = exp(-pow((length((vUv - 0.5) * aspect) - 0.20) / 0.0035, 2.0));
	col += vec3(0.35, 0.9, 0.85) * reticle * 0.16;

	/* ---- rolling scan sweep ------------------------------------------ */
	float sweep = fract(u_time * 0.18);
	float sweepBand = exp(-pow((vUv.y - sweep) / 0.018, 2.0));
	col += vec3(0.30, 0.95, 0.80) * sweepBand * 0.035;

	fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
