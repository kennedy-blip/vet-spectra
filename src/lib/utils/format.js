/**
 * VET-SPECTRA · format.js — formatting + canvas drawing helpers.
 * Pure ES2024, no dependencies.
 */

export function fmt(value, digits = 0) {
	if (!isFinite(value)) return '—';
	return Number(value).toLocaleString('en-US', {
		minimumFractionDigits: digits,
		maximumFractionDigits: digits
	});
}

export function fmtMgKg(v) {
	if (!isFinite(v)) return '—';
	if (v >= 1000) return `${fmt(v, 0)}`;
	if (v >= 100) return fmt(v, 0);
	if (v >= 10) return fmt(v, 1);
	return fmt(v, 2);
}

export function fmtHours(h) {
	if (!isFinite(h)) return '—';
	if (h < 1) return `${Math.round(h * 60)} min`;
	if (h < 48) return `${h.toFixed(1)} h`;
	const days = h / 24;
	return `${days.toFixed(1)} d`;
}

export function fmtPct(v, digits = 0) {
	if (!isFinite(v)) return '—';
	return `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

export function clamp(v, lo, hi) {
	return Math.min(hi, Math.max(lo, v));
}

export function lerp(a, b, t) {
	return a + (b - a) * t;
}

export function mapRange(v, inMin, inMax, outMin, outMax) {
	const t = (v - inMin) / Math.max(1e-9, inMax - inMin);
	return outMin + (outMax - outMin) * clamp(t, 0, 1);
}

export function timeAgo(iso) {
	if (!iso) return '—';
	const dt = Date.now() - new Date(iso).getTime();
	const min = Math.round(dt / 60000);
	if (min < 1) return 'just now';
	if (min < 60) return `${min} min ago`;
	const h = Math.round(min / 60);
	if (h < 24) return `${h} h ago`;
	return `${Math.round(h / 24)} d ago`;
}

export function clockHHMM(date = new Date()) {
	return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function isoDay(date = new Date()) {
	return date.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ canvas */
/** Hi-DPI canvas setup. Returns CSS-pixel dimensions for drawing maths. */
export function setupCanvas(canvas, cssHeight = null) {
	if (!canvas) return null;
	const dpr = Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
	const rect = canvas.getBoundingClientRect();
	const wCss = Math.max(80, rect.width || canvas.clientWidth || 300);
	const hCss = Math.max(40, cssHeight || rect.height || canvas.clientHeight || 160);
	const w = Math.floor(wCss * dpr);
	const h = Math.floor(hCss * dpr);
	if (canvas.width !== w || canvas.height !== h) {
		canvas.width = w;
		canvas.height = h;
	}
	const ctx = canvas.getContext('2d');
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, wCss, hCss);
	return { ctx, w: wCss, h: hCss, dpr };
}

export function cssVar(name, fallback = '#ffffff') {
	if (typeof window === 'undefined') return fallback;
	const v = getComputedStyle(document.documentElement).getPropertyValue(name);
	return v && v.trim() ? v.trim() : fallback;
}

export function withAlpha(color, alpha) {
	// Handles #rrggbb, rgb(), and hsl() inputs.
	if (color.startsWith('#')) {
		const hex = color.slice(1);
		const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
		const r = parseInt(full.slice(0, 2), 16);
		const g = parseInt(full.slice(2, 4), 16);
		const b = parseInt(full.slice(4, 6), 16);
		return `rgba(${r}, ${g}, ${b}, ${alpha})`;
	}
	if (color.startsWith('rgb(')) return color.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`);
	if (color.startsWith('rgba(')) {
		return color.replace(/rgba\(([^,]+),([^,]+),([^,]+),[^)]+\)/, `rgba($1,$2,$3,${alpha})`);
	}
	return color;
}

export function roundRect(ctx, x, y, w, h, r) {
	const radius = Math.min(r, w / 2, h / 2);
	ctx.beginPath();
	ctx.moveTo(x + radius, y);
	ctx.arcTo(x + w, y, x + w, y + h, radius);
	ctx.arcTo(x + w, y + h, x, y + h, radius);
	ctx.arcTo(x, y + h, x, y, radius);
	ctx.arcTo(x, y, x + w, y, radius);
	ctx.closePath();
}

export function drawGrid(ctx, { w, h, cols = 6, rows = 4, color = 'rgba(255,255,255,0.06)', dashed = true }) {
	ctx.save();
	ctx.strokeStyle = color;
	ctx.lineWidth = 1;
	if (dashed) ctx.setLineDash([2, 4]);
	for (let i = 1; i < cols; i++) {
		const x = Math.round((w / cols) * i) + 0.5;
		ctx.beginPath();
		ctx.moveTo(x, 0);
		ctx.lineTo(x, h);
		ctx.stroke();
	}
	for (let j = 1; j < rows; j++) {
		const y = Math.round((h / rows) * j) + 0.5;
		ctx.beginPath();
		ctx.moveTo(0, y);
		ctx.lineTo(w, y);
		ctx.stroke();
	}
	ctx.restore();
}

export function drawPolyline(ctx, points, { x, y, w, h }, { min, max, color = '#10b981', width = 1.6, fill = null, close = false }) {
	if (!points || points.length < 2) return;
	const span = Math.max(1e-6, max - min);
	const px = (i) => x + (w * i) / (points.length - 1);
	const py = (v) => y + h - ((clamp(v, min, max) - min) / span) * h;

	ctx.save();
	if (fill) {
		const grad = ctx.createLinearGradient(0, y, 0, y + h);
		grad.addColorStop(0, fill);
		grad.addColorStop(1, 'rgba(0,0,0,0)');
		ctx.beginPath();
		ctx.moveTo(px(0), py(points[0]));
		for (let i = 1; i < points.length; i++) ctx.lineTo(px(i), py(points[i]));
		if (close) {
			ctx.lineTo(px(points.length - 1), y + h);
			ctx.lineTo(px(0), y + h);
		}
		ctx.closePath();
		ctx.fillStyle = grad;
		ctx.fill();
	}
	ctx.beginPath();
	ctx.moveTo(px(0), py(points[0]));
	for (let i = 1; i < points.length; i++) ctx.lineTo(px(i), py(points[i]));
	ctx.strokeStyle = color;
	ctx.lineWidth = width;
	ctx.lineJoin = 'round';
	ctx.lineCap = 'round';
	ctx.shadowColor = color;
	ctx.shadowBlur = 6;
	ctx.stroke();
	ctx.restore();
}

export function drawAxisLabel(ctx, text, x, y, { color = 'rgba(255,255,255,0.42)', size = 9, align = 'left', baseline = 'middle' } = {}) {
	ctx.save();
	ctx.fillStyle = color;
	ctx.font = `600 ${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
	ctx.textAlign = align;
	ctx.textBaseline = baseline;
	ctx.fillText(text, x, y);
	ctx.restore();
}

export function drawDot(ctx, x, y, r, color) {
	ctx.save();
	ctx.beginPath();
	ctx.arc(x, y, r, 0, Math.PI * 2);
	ctx.fillStyle = color;
	ctx.shadowColor = color;
	ctx.shadowBlur = 8;
	ctx.fill();
	ctx.restore();
}

/** Sample a callback every `frames` to keep animation draw cost bounded. */
export function createThrottle(fps = 30) {
	const minDelta = 1000 / fps;
	let last = 0;
	return function throttled() {
		const now = performance.now();
		if (now - last < minDelta) return false;
		last = now;
		return true;
	};
}

export function prefersReducedMotion() {
	if (typeof window === 'undefined') return false;
	return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/* ------------------------------------------------------------------ misc */
export function hashString(str) {
	let h = 2166136261;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}

export function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
