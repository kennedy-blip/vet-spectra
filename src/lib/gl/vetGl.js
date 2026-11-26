/**
 * VET-SPECTRA · vetGl.js
 * Tiny hand-rolled WebGL2 harness (no three.js, no regl).
 * Handles shader compilation, context-loss recovery, DPR-capped sizing,
 * low-power frame throttling and texture upload for the macro-lens view.
 */

import biovitalFragSource from '../../shaders/biovital_glass_underlay.glsl?raw';
import macroLensFragSource from '../../shaders/tick_gingival_macro_lens.glsl?raw';

export const VERTEX_SOURCE = `#version 300 es
in vec2 a_pos;
out vec2 vUv;
void main() {
	vUv = a_pos * 0.5 + 0.5;
	gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const QUAD = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);

export function compileShader(gl, type, source) {
	const shader = gl.createShader(type);
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		const log = gl.getShaderInfoLog(shader);
		gl.deleteShader(shader);
		throw new Error(`Shader compile failed: ${log}`);
	}
	return shader;
}

export function linkProgram(gl, vertexSource, fragmentSource) {
	const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
	const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
	const program = gl.createProgram();
	gl.attachShader(program, vs);
	gl.attachShader(program, fs);
	gl.bindAttribLocation(program, 0, 'a_pos');
	gl.linkProgram(program);
	gl.deleteShader(vs);
	gl.deleteShader(fs);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		const log = gl.getProgramInfoLog(program);
		gl.deleteProgram(program);
		throw new Error(`Program link failed: ${log}`);
	}
	return program;
}

function setupQuad(gl) {
	const buffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
	gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
	const vao = gl.createVertexArray();
	gl.bindVertexArray(vao);
	gl.enableVertexAttribArray(0);
	gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
	gl.bindVertexArray(null);
	return { buffer, vao };
}

function sizeCanvas(canvas, gl, maxDpr = 1.6) {
	const dpr = Math.min(maxDpr, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
	const w = Math.max(1, Math.floor((canvas.clientWidth || canvas.width) * dpr));
	const h = Math.max(1, Math.floor((canvas.clientHeight || canvas.height) * dpr));
	if (canvas.width !== w || canvas.height !== h) {
		canvas.width = w;
		canvas.height = h;
	}
	gl.viewport(0, 0, w, h);
	return { w, h, dpr };
}

/**
 * Mount the living-glass biovital underlay.
 * @returns {null | {setState:Function,start:Function,stop:Function,destroy:Function,ok:boolean}}
 */
export function createUnderlay(canvas, { onError } = {}) {
	if (!canvas) return null;
	const gl = canvas.getContext('webgl2', {
		alpha: false,
		antialias: false,
		depth: false,
		stencil: false,
		powerPreference: 'low-power',
		preserveDrawingBuffer: false
	});
	if (!gl) {
		onError?.('WebGL2 unavailable — CSS gradient fallback active');
		return null;
	}

	let program;
	try {
		program = linkProgram(gl, VERTEX_SOURCE, biovitalFragSource);
	} catch (err) {
		onError?.(String(err.message || err));
		return null;
	}
	const { vao } = setupQuad(gl);
	gl.useProgram(program);

	const u = {
		resolution: gl.getUniformLocation(program, 'u_resolution'),
		time: gl.getUniformLocation(program, 'u_time'),
		theme: gl.getUniformLocation(program, 'u_theme'),
		energy: gl.getUniformLocation(program, 'u_energy'),
		toxicity: gl.getUniformLocation(program, 'u_toxicity'),
		hr: gl.getUniformLocation(program, 'u_hr'),
		eco: gl.getUniformLocation(program, 'u_eco')
	};

	let state = { theme: 0, energy: 0.12, toxicity: 0, hr: 96, eco: 0 };
	let raf = 0;
	let running = false;
	let startTs = 0;
	let lastDraw = 0;
	let lost = false;

	canvas.addEventListener('webglcontextlost', (e) => {
		e.preventDefault();
		lost = true;
		stop();
	});
	canvas.addEventListener('webglcontextrestored', () => {
		lost = false;
	});

	function frame(now) {
		if (!running || lost) return;
		raf = requestAnimationFrame(frame);
		const eco = state.eco > 0.5;
		const minDelta = eco ? 1000 / 18 : 1000 / 60;
		if (now - lastDraw < minDelta) return;
		lastDraw = now;
		const t = (now - startTs) / 1000;
		const size = sizeCanvas(canvas, gl, eco ? 1.0 : 1.6);

		gl.useProgram(program);
		gl.bindVertexArray(vao);
		gl.uniform2f(u.resolution, size.w, size.h);
		gl.uniform1f(u.time, t);
		gl.uniform1f(u.theme, state.theme);
		gl.uniform1f(u.energy, state.energy);
		gl.uniform1f(u.toxicity, state.toxicity);
		gl.uniform1f(u.hr, state.hr);
		gl.uniform1f(u.eco, state.eco);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}

	function start() {
		if (running) return;
		running = true;
		startTs = performance.now();
		lastDraw = 0;
		raf = requestAnimationFrame(frame);
	}

	function stop() {
		running = false;
		if (raf) cancelAnimationFrame(raf);
		raf = 0;
	}

	function destroy() {
		stop();
		try {
			gl.deleteProgram(program);
			gl.deleteVertexArray(vao);
			gl.getExtension('WEBGL_lose_context')?.loseContext();
		} catch {
			/* already gone */
		}
	}

	return {
		ok: true,
		gl,
		start,
		stop,
		destroy,
		renderOnce() {
			sizeCanvas(canvas, gl, 1);
			gl.useProgram(program);
			gl.bindVertexArray(vao);
			gl.uniform2f(u.resolution, canvas.width, canvas.height);
			gl.uniform1f(u.time, 1);
			gl.uniform1f(u.theme, state.theme);
			gl.uniform1f(u.energy, state.energy);
			gl.uniform1f(u.toxicity, state.toxicity);
			gl.uniform1f(u.hr, state.hr);
			gl.uniform1f(u.eco, state.eco);
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		},
		setState(patch) {
			state = { ...state, ...patch };
		},
		getState() {
			return { ...state };
		},
		isRunning: () => running
	};
}

/**
 * Macro-lens compositor for the tick / gingival camera.
 * @returns {null | object}
 */
export function createMacroLens(canvas, { onError } = {}) {
	if (!canvas) return null;
	const gl = canvas.getContext('webgl2', {
		alpha: false,
		antialias: false,
		depth: false,
		stencil: false,
		powerPreference: 'low-power'
	});
	if (!gl) {
		onError?.('WebGL2 unavailable for the macro lens');
		return null;
	}

	let program;
	try {
		program = linkProgram(gl, VERTEX_SOURCE, macroLensFragSource);
	} catch (err) {
		onError?.(String(err.message || err));
		return null;
	}
	const { vao } = setupQuad(gl);
	gl.useProgram(program);

	const u = {
		tex: gl.getUniformLocation(program, 'u_tex'),
		resolution: gl.getUniformLocation(program, 'u_resolution'),
		time: gl.getUniformLocation(program, 'u_time'),
		zoom: gl.getUniformLocation(program, 'u_zoom'),
		edge: gl.getUniformLocation(program, 'u_edge'),
		mode: gl.getUniformLocation(program, 'u_mode'),
		falseColor: gl.getUniformLocation(program, 'u_falseColor'),
		uvOffset: gl.getUniformLocation(program, 'u_uvOffset')
	};

	const texture = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, texture);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([18, 26, 38, 255]));
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

	let state = { zoom: 1.9, edge: 0.45, mode: 0, falseColor: 0, uvOffset: [0, 0] };
	let raf = 0;
	let running = false;
	let startTs = 0;
	let lost = false;
	let hasTexture = false;

	canvas.addEventListener('webglcontextlost', (e) => {
		e.preventDefault();
		lost = true;
		stop();
	});
	canvas.addEventListener('webglcontextrestored', () => {
		lost = false;
	});

	function upload(source) {
		if (!source) return;
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
		hasTexture = true;
	}

	function frame(now) {
		if (!running || lost) return;
		raf = requestAnimationFrame(frame);
		const t = (now - startTs) / 1000;
		const size = sizeCanvas(canvas, gl, 1.5);
		gl.useProgram(program);
		gl.bindVertexArray(vao);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.uniform1i(u.tex, 0);
		gl.uniform2f(u.resolution, size.w, size.h);
		gl.uniform1f(u.time, t);
		gl.uniform1f(u.zoom, state.zoom);
		gl.uniform1f(u.edge, state.edge);
		gl.uniform1f(u.mode, state.mode);
		gl.uniform1f(u.falseColor, state.falseColor);
		gl.uniform2f(u.uvOffset, state.uvOffset[0], state.uvOffset[1]);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}

	function start() {
		if (running) return;
		running = true;
		startTs = performance.now();
		raf = requestAnimationFrame(frame);
	}

	function stop() {
		running = false;
		if (raf) cancelAnimationFrame(raf);
		raf = 0;
	}

	return {
		ok: true,
		gl,
		start,
		stop,
		upload,
		hasTexture: () => hasTexture,
		setState(patch) {
			state = { ...state, ...patch };
		},
		getState: () => ({ ...state }),
		destroy() {
			stop();
			try {
				gl.deleteTexture(texture);
				gl.deleteProgram(program);
				gl.deleteVertexArray(vao);
				gl.getExtension('WEBGL_lose_context')?.loseContext();
			} catch {
				/* gone */
			}
		}
	};
}

/** WebGL capability probe used by the hardware gatekeeper + admin console. */
export function probeWebGl() {
	if (typeof document === 'undefined') return { webgl2: false, renderer: 'ssr', maxTexture: 0 };
	const canvas = document.createElement('canvas');
	const gl = canvas.getContext('webgl2');
	if (!gl) return { webgl2: false, renderer: 'none', maxTexture: 0 };
	const dbg = gl.getExtension('WEBGL_debug_renderer_info');
	const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'masked';
	const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
	const ext = gl.getExtension('WEBGL_lose_context');
	if (ext) ext.loseContext();
	return {
		webgl2: true,
		renderer: String(renderer),
		maxTexture,
		glslVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION)
	};
}
