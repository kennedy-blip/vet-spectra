/**
 * VET-SPECTRA · dspKernels.js
 * ---------------------------------------------------------------------------
 * Shared signal-processing kernels (pure ES2024, typed-array friendly).
 * Used by the bio-acoustic airway lab and the cardio-pulmonary SCG/PCG lab.
 *   • radix-2 iterative FFT + real magnitude spectra
 *   • Hann / Hamming windows, STFT frame builder
 *   • RBJ biquad designer + zero-phase forward/backward Butterworth filtering
 *   • Shannon energy envelope, adaptive peak picking, median smoothing
 *   • deterministic mulberry32 PRNG for reproducible simulations
 * ---------------------------------------------------------------------------
 */

/* ---------------------------------------------------------------- FFT ---- */
export function fftInPlace(re, im) {
	const n = re.length;
	if (n <= 1) return;
	if ((n & (n - 1)) !== 0) throw new Error('FFT length must be a power of two');

	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			let t = re[i];
			re[i] = re[j];
			re[j] = t;
			t = im[i];
			im[i] = im[j];
			im[j] = t;
		}
	}

	for (let len = 2; len <= n; len <<= 1) {
		const ang = (-2 * Math.PI) / len;
		const wr = Math.cos(ang);
		const wi = Math.sin(ang);
		for (let i = 0; i < n; i += len) {
			let cr = 1;
			let ci = 0;
			for (let k = 0; k < len >> 1; k++) {
				const ur = re[i + k];
				const ui = im[i + k];
				const vr = re[i + k + (len >> 1)] * cr - im[i + k + (len >> 1)] * ci;
				const vi = re[i + k + (len >> 1)] * ci + im[i + k + (len >> 1)] * cr;
				re[i + k] = ur + vr;
				im[i + k] = ui + vi;
				re[i + k + (len >> 1)] = ur - vr;
				im[i + k + (len >> 1)] = ui - vi;
				const ncr = cr * wr - ci * wi;
				ci = cr * wi + ci * wr;
				cr = ncr;
			}
		}
	}
}

export function magnitudeSpectrum(samples, fftSize = 1024) {
	const re = new Float32Array(fftSize);
	const im = new Float32Array(fftSize);
	const n = Math.min(fftSize, samples.length);
	for (let i = 0; i < n; i++) re[i] = samples[i] * hann(i, fftSize);
	fftInPlace(re, im);
	const half = fftSize >> 1;
	const mag = new Float32Array(half);
	for (let i = 0; i < half; i++) mag[i] = Math.hypot(re[i], im[i]) / half;
	return mag;
}

export function hann(i, n) {
	return 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
}

/** Frame a signal into overlapping windows. */
export function stftFrames(samples, fftSize = 512, hop = 128) {
	const frames = [];
	for (let start = 0; start + fftSize <= samples.length; start += hop) {
		const seg = samples.subarray(start, start + fftSize);
		frames.push({ t: start, mag: magnitudeSpectrum(seg, fftSize) });
	}
	return frames;
}

/* ------------------------------------------------------------- BIQUAD ---- */
const Q_BUTTER = Math.SQRT1_2; // 0.7071

export function biquadCoeffs(type, fc, fs, q = Q_BUTTER, gainDb = 0) {
	const w0 = (2 * Math.PI * Math.min(fc, fs * 0.49)) / fs;
	const cosW = Math.cos(w0);
	const sinW = Math.sin(w0);
	const alpha = sinW / (2 * Math.max(0.05, q));
	const A = Math.pow(10, gainDb / 40);
	let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;

	if (type === 'lowpass') {
		b0 = (1 - cosW) / 2;
		b1 = 1 - cosW;
		b2 = (1 - cosW) / 2;
		a0 = 1 + alpha;
		a1 = -2 * cosW;
		a2 = 1 - alpha;
	} else if (type === 'highpass') {
		b0 = (1 + cosW) / 2;
		b1 = -(1 + cosW);
		b2 = (1 + cosW) / 2;
		a0 = 1 + alpha;
		a1 = -2 * cosW;
		a2 = 1 - alpha;
	} else if (type === 'bandpass') {
		b0 = alpha;
		b1 = 0;
		b2 = -alpha;
		a0 = 1 + alpha;
		a1 = -2 * cosW;
		a2 = 1 - alpha;
	} else if (type === 'peak') {
		b0 = 1 + alpha * A;
		b1 = -2 * cosW;
		b2 = 1 - alpha * A;
		a0 = 1 + alpha / A;
		a1 = -2 * cosW;
		a2 = 1 - alpha / A;
	}
	return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export function biquadRun(input, c) {
	const y = new Float32Array(input.length);
	let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
	for (let i = 0; i < input.length; i++) {
		const x0 = input[i];
		const out = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
		x2 = x1; x1 = x0; y2 = y1; y1 = out;
		y[i] = out;
	}
	return y;
}

/**
 * Butterworth band-pass built from cascaded 2nd-order high-pass + low-pass
 * sections. `passes` doubles the slope (2 → 24 dB/oct, 3 → 36 dB/oct).
 */
export function bandpass(input, fs, lowHz, highHz, passes = 2) {
	let out = input;
	const hp = biquadCoeffs('highpass', lowHz, fs, Q_BUTTER);
	const lp = biquadCoeffs('lowpass', highHz, fs, Q_BUTTER);
	for (let p = 0; p < passes; p++) {
		out = biquadRun(out, hp);
		out = biquadRun(out, lp);
	}
	return out;
}

export function lowpass(input, fs, cutoff, passes = 2) {
	let out = input;
	const c = biquadCoeffs('lowpass', cutoff, fs, Q_BUTTER);
	for (let p = 0; p < passes; p++) out = biquadRun(out, c);
	return out;
}

export function highpass(input, fs, cutoff, passes = 2) {
	let out = input;
	const c = biquadCoeffs('highpass', cutoff, fs, Q_BUTTER);
	for (let p = 0; p < passes; p++) out = biquadRun(out, c);
	return out;
}

/** Zero-phase forward/backward application (halves the effective order). */
export function filtfilt(input, fs, lowHz, highHz, passes = 2) {
	const fwd = bandpass(input, fs, lowHz, highHz, passes);
	const rev = new Float32Array(fwd.length);
	for (let i = 0; i < fwd.length; i++) rev[i] = fwd[fwd.length - 1 - i];
	const back = bandpass(rev, fs, lowHz, highHz, passes);
	const out = new Float32Array(fwd.length);
	for (let i = 0; i < out.length; i++) out[i] = back[back.length - 1 - i];
	return out;
}

/** Notch (60/50 Hz mains hum removal) via a peak filter with negative gain. */
export function notch(input, fs, f0 = 50, q = 30) {
	return biquadRun(input, biquadCoeffs('peak', f0, fs, q, -34));
}

/* ----------------------------------------------------------- ENVELOPES ---- */
export function rms(signal, from = 0, to = signal.length) {
	let s = 0;
	const a = Math.max(0, from);
	const b = Math.min(signal.length, to);
	for (let i = a; i < b; i++) s += signal[i] * signal[i];
	return Math.sqrt(s / Math.max(1, b - a));
}

export function dbfs(amplitude) {
	return 20 * Math.log10(Math.max(1e-7, Math.abs(amplitude)));
}

/** Shannon energy:  E = −Σ x²(n)·log(x²(n)) over a sliding window. */
export function shannonEnergyEnvelope(signal, win = 64) {
	const half = win >> 1;
	const env = new Float32Array(signal.length);
	for (let i = 0; i < signal.length; i++) {
		let acc = 0;
		const a = Math.max(0, i - half);
		const b = Math.min(signal.length, i + half);
		for (let j = a; j < b; j++) {
			const e = signal[j] * signal[j];
			if (e > 1e-12) acc += -e * Math.log(e);
		}
		env[i] = acc / Math.max(1, b - a);
	}
	return env;
}

export function envelopeAbs(signal, win = 128) {
	const out = new Float32Array(signal.length);
	const half = win >> 1;
	for (let i = 0; i < signal.length; i++) {
		let peak = 0;
		const a = Math.max(0, i - half);
		const b = Math.min(signal.length, i + half);
		for (let j = a; j < b; j++) peak = Math.max(peak, Math.abs(signal[j]));
		out[i] = peak;
	}
	return out;
}

export function medianSmooth(signal, win = 5) {
	const half = win >> 1;
	const out = new Float32Array(signal.length);
	const buf = [];
	for (let i = 0; i < signal.length; i++) {
		buf.length = 0;
		for (let j = i - half; j <= i + half; j++) {
			if (j >= 0 && j < signal.length) buf.push(signal[j]);
		}
		buf.sort((a, b) => a - b);
		out[i] = buf[buf.length >> 1];
	}
	return out;
}

export function movingAverage(signal, win = 9) {
	const out = new Float32Array(signal.length);
	let acc = 0;
	const half = win >> 1;
	for (let i = 0; i < signal.length; i++) {
		acc = 0;
		let count = 0;
		for (let j = i - half; j <= i + half; j++) {
			if (j >= 0 && j < signal.length) { acc += signal[j]; count++; }
		}
		out[i] = acc / count;
	}
	return out;
}

/**
 * Adaptive peak picker: local maxima above `minHeight` × max, separated by
 * at least `minGap` samples.
 */
export function pickPeaks(env, { minHeightRatio = 0.28, minGap = 32 } = {}) {
	let max = 0;
	for (let i = 0; i < env.length; i++) max = Math.max(max, env[i]);
	const thr = max * minHeightRatio;
	const peaks = [];
	for (let i = 1; i < env.length - 1; i++) {
		if (env[i] >= thr && env[i] >= env[i - 1] && env[i] > env[i + 1]) {
			const last = peaks[peaks.length - 1];
			if (last == null || i - last >= minGap) peaks.push(i);
		}
	}
	return peaks;
}

/* --------------------------------------------------------------- MISC ---- */
export function mulberry32(seed = 0x9e3779b9) {
	let a = seed >>> 0;
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function gaussianNoise(length, rand, scale = 1) {
	const out = new Float32Array(length);
	for (let i = 0; i < length; i++) {
		const u = Math.max(1e-9, rand());
		const v = rand();
		out[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * scale;
	}
	return out;
}

export function normalize(signal, target = 0.92) {
	let max = 0;
	for (let i = 0; i < signal.length; i++) max = Math.max(max, Math.abs(signal[i]));
	if (max < 1e-9) return signal;
	const k = target / max;
	const out = new Float32Array(signal.length);
	for (let i = 0; i < signal.length; i++) out[i] = signal[i] * k;
	return out;
}

export function mean(arr) {
	if (!arr.length) return 0;
	let s = 0;
	for (let i = 0; i < arr.length; i++) s += arr[i];
	return s / arr.length;
}

export function stdev(arr) {
	if (arr.length < 2) return 0;
	const m = mean(arr);
	let s = 0;
	for (let i = 0; i < arr.length; i++) s += (arr[i] - m) * (arr[i] - m);
	return Math.sqrt(s / (arr.length - 1));
}

export function median(arr) {
	if (!arr.length) return 0;
	const copy = Array.from(arr).sort((a, b) => a - b);
	const mid = copy.length >> 1;
	return copy.length % 2 ? copy[mid] : (copy[mid - 1] + copy[mid]) / 2;
}

export function clamp(v, lo, hi) {
	return Math.min(hi, Math.max(lo, v));
}

export function linspace(a, b, n) {
	const out = new Float64Array(n);
	for (let i = 0; i < n; i++) out[i] = a + ((b - a) * i) / Math.max(1, n - 1);
	return out;
}
