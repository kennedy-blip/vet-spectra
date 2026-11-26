/**
 * VET-SPECTRA · qrSvg.js
 * ---------------------------------------------------------------------------
 * Dependency-free QR Code encoder (ISO/IEC 18004).
 *   • Byte mode, version 4 (33 × 33), error-correction level L
 *   • GF(256) Reed–Solomon ECC (20 codewords)
 *   • All 8 data masks evaluated with the standard penalty rules
 *   • BCH(15,5) format information + dark module
 *   • Emits an inline, self-contained SVG string (no network, no fonts)
 * Used by the APK download modal so the install URL is scannable offline.
 * ---------------------------------------------------------------------------
 */

export const QR_VERSION = 4;
export const QR_SIZE = 17 + 4 * QR_VERSION; // 33
const ECC_CODEWORDS = 20;
const DATA_CODEWORDS = 80;
const MAX_TEXT_BYTES = DATA_CODEWORDS - 2; // mode + length header

/* ----------------------------------------------------------- GF(256) ---- */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(function initGalois() {
	let x = 1;
	for (let i = 0; i < 255; i++) {
		EXP[i] = x;
		LOG[x] = i;
		x <<= 1;
		if (x & 0x100) x ^= 0x11d;
	}
	for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
	if (a === 0 || b === 0) return 0;
	return EXP[LOG[a] + LOG[b]];
}

function rsGenerator(degree) {
	let poly = new Uint8Array([1]);
	for (let i = 0; i < degree; i++) {
		const next = new Uint8Array(poly.length + 1);
		for (let j = 0; j < poly.length; j++) {
			next[j] ^= poly[j];
			next[j + 1] ^= gfMul(poly[j], EXP[i]);
		}
		poly = next;
	}
	return poly;
}

function rsRemainder(data, ecLen) {
	const gen = rsGenerator(ecLen);
	const res = new Uint8Array(data.length + ecLen);
	res.set(data);
	for (let i = 0; i < data.length; i++) {
		const coef = res[i];
		if (coef === 0) continue;
		for (let j = 0; j < gen.length; j++) res[i + j] ^= gfMul(gen[j], coef);
	}
	return res.slice(data.length);
}

/* --------------------------------------------------------- bit buffer --- */
function textToBytes(text) {
	return Array.from(new TextEncoder().encode(text));
}

function buildCodewords(text) {
	const bytes = textToBytes(text);
	if (bytes.length > MAX_TEXT_BYTES) {
		throw new Error(`QR payload too large: ${bytes.length} bytes (max ${MAX_TEXT_BYTES} for version 4-L)`);
	}
	const bits = [];
	const push = (value, length) => {
		for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
	};
	push(0b0100, 4); // byte mode
	push(bytes.length, 8); // char count (versions 1–9)
	for (const b of bytes) push(b, 8);

	const capacityBits = DATA_CODEWORDS * 8;
	const terminator = Math.min(4, capacityBits - bits.length);
	push(0, terminator);
	while (bits.length % 8 !== 0) bits.push(0);

	const dataCodewords = new Uint8Array(DATA_CODEWORDS);
	for (let i = 0; i < bits.length / 8; i++) {
		let byte = 0;
		for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i * 8 + j];
		dataCodewords[i] = byte;
	}
	// Pad codewords alternate 0xEC / 0x11
	const written = bits.length / 8;
	for (let i = written; i < DATA_CODEWORDS; i++) dataCodewords[i] = (i - written) % 2 === 0 ? 0xec : 0x11;
	return dataCodewords;
}

/* ------------------------------------------------------------- matrix --- */
function createGrid(value) {
	return Array.from({ length: QR_SIZE }, () => new Array(QR_SIZE).fill(value));
}

function placeFinder(matrix, reserved, cx, cy) {
	for (let dy = -1; dy <= 7; dy++) {
		for (let dx = -1; dx <= 7; dx++) {
			const x = cx + dx;
			const y = cy + dy;
			if (x < 0 || y < 0 || x >= QR_SIZE || y >= QR_SIZE) continue;
			const inRing = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
			const isDark =
				inRing &&
				(dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
			matrix[y][x] = isDark ? 1 : 0;
			reserved[y][x] = true;
		}
	}
}

function placeAlignment(matrix, reserved, cx, cy) {
	for (let dy = -2; dy <= 2; dy++) {
		for (let dx = -2; dx <= 2; dx++) {
			const dark = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
			matrix[cy + dy][cx + dx] = dark ? 1 : 0;
			reserved[cy + dy][cx + dx] = true;
		}
	}
}

function placeFunctionPatterns(matrix, reserved) {
	// finders + separators
	placeFinder(matrix, reserved, 0, 0);
	placeFinder(matrix, reserved, QR_SIZE - 7, 0);
	placeFinder(matrix, reserved, 0, QR_SIZE - 7);

	// timing patterns
	for (let i = 8; i < QR_SIZE - 8; i++) {
		const v = i % 2 === 0 ? 1 : 0;
		matrix[6][i] = v;
		reserved[6][i] = true;
		matrix[i][6] = v;
		reserved[i][6] = true;
	}

	// alignment pattern (version 4 → single centre at 26,26)
	placeAlignment(matrix, reserved, 26, 26);

	// reserve format information areas
	for (let i = 0; i <= 8; i++) {
		reserved[8][i] = true;
		reserved[i][8] = true;
	}
	for (let i = 0; i < 8; i++) {
		reserved[8][QR_SIZE - 1 - i] = true;
		reserved[QR_SIZE - 1 - i][8] = true;
	}
	reserved[8][QR_SIZE - 8] = true; // dark module
}

function placeFormatBits(matrix, mask) {
	const eclBits = 1; // L
	const data = (eclBits << 3) | mask;
	let rem = data;
	for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
	const bits = ((data << 10) | rem) ^ 0x5412;

	const bit = (i) => ((bits >>> i) & 1) === 1;
	const setFn = (col, row, v) => {
		matrix[row][col] = v ? 1 : 0;
	};

	for (let i = 0; i <= 5; i++) setFn(8, i, bit(i));
	setFn(8, 7, bit(6));
	setFn(8, 8, bit(7));
	setFn(7, 8, bit(8));
	for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(i));

	for (let i = 0; i < 8; i++) setFn(QR_SIZE - 1 - i, 8, bit(i));
	for (let i = 8; i < 15; i++) setFn(8, QR_SIZE - 15 + i, bit(i));
	setFn(8, QR_SIZE - 8, true); // fixed dark module
}

function placeDataBits(matrix, reserved, codewords) {
	const bits = [];
	for (const cw of codewords) {
		for (let i = 7; i >= 0; i--) bits.push((cw >>> i) & 1);
	}
	let index = 0;
	let upward = true;
	for (let right = QR_SIZE - 1; right >= 1; right -= 2) {
		if (right === 6) right = 5; // skip the vertical timing column
		for (let vert = 0; vert < QR_SIZE; vert++) {
			const y = upward ? QR_SIZE - 1 - vert : vert;
			for (let k = 0; k < 2; k++) {
				const x = right - k;
				if (reserved[y][x]) continue;
				matrix[y][x] = index < bits.length ? bits[index] : 0;
				index++;
			}
		}
		upward = !upward;
	}
}

function maskFn(mask, row, col) {
	switch (mask) {
		case 0: return (row + col) % 2 === 0;
		case 1: return row % 2 === 0;
		case 2: return col % 3 === 0;
		case 3: return (row + col) % 3 === 0;
		case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
		case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
		case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
		case 7: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
		default: return false;
	}
}

function applyMask(matrix, reserved, mask) {
	const out = matrix.map((row) => row.slice());
	for (let y = 0; y < QR_SIZE; y++) {
		for (let x = 0; x < QR_SIZE; x++) {
			if (reserved[y][x]) continue;
			if (maskFn(mask, y, x)) out[y][x] ^= 1;
		}
	}
	return out;
}

function penaltyScore(m) {
	let score = 0;
	// rule 1: runs of ≥ 5
	for (let y = 0; y < QR_SIZE; y++) {
		let run = 1;
		for (let x = 1; x < QR_SIZE; x++) {
			if (m[y][x] === m[y][x - 1]) run++;
			else {
				if (run >= 5) score += 3 + (run - 5);
				run = 1;
			}
		}
		if (run >= 5) score += 3 + (run - 5);
	}
	for (let x = 0; x < QR_SIZE; x++) {
		let run = 1;
		for (let y = 1; y < QR_SIZE; y++) {
			if (m[y][x] === m[y - 1][x]) run++;
			else {
				if (run >= 5) score += 3 + (run - 5);
				run = 1;
			}
		}
		if (run >= 5) score += 3 + (run - 5);
	}
	// rule 2: 2×2 blocks
	for (let y = 0; y < QR_SIZE - 1; y++) {
		for (let x = 0; x < QR_SIZE - 1; x++) {
			const v = m[y][x];
			if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) score += 3;
		}
	}
	// rule 3: finder-like patterns
	const pattern = [1, 0, 1, 1, 1, 0, 1];
	const check = (get, n) => {
		for (let i = 0; i + 11 <= n; i++) {
			let a = true;
			let b = true;
			for (let j = 0; j < 7; j++) {
				if (get(i + 4 + j) !== pattern[j]) a = false;
				if (get(i + j) !== pattern[j]) b = false;
			}
			if (a || b) score += 40;
		}
	};
	for (let y = 0; y < QR_SIZE; y++) check((i) => m[y][i], QR_SIZE);
	for (let x = 0; x < QR_SIZE; x++) check((i) => m[i][x], QR_SIZE);
	// rule 4: dark balance
	let dark = 0;
	for (const row of m) for (const v of row) dark += v;
	const pct = (dark * 100) / (QR_SIZE * QR_SIZE);
	score += Math.floor(Math.abs(pct - 50) / 5) * 10;
	return score;
}

/**
 * Encode text into a boolean module matrix (true = dark).
 * @param {string} text
 * @returns {boolean[][]}
 */
export function qrMatrix(text) {
	const dataCodewords = buildCodewords(text);
	const ec = rsRemainder(dataCodewords, ECC_CODEWORDS);
	const codewords = new Uint8Array(DATA_CODEWORDS + ECC_CODEWORDS);
	codewords.set(dataCodewords, 0);
	codewords.set(ec, DATA_CODEWORDS);

	const base = createGrid(0);
	const reserved = createGrid(false);
	placeFunctionPatterns(base, reserved);
	placeDataBits(base, reserved, codewords);

	let best = null;
	let bestScore = Infinity;
	let bestMask = 0;
	for (let mask = 0; mask < 8; mask++) {
		const candidate = applyMask(base, reserved, mask);
		placeFormatBits(candidate, mask);
		const score = penaltyScore(candidate);
		if (score < bestScore) {
			bestScore = score;
			best = candidate;
			bestMask = mask;
		}
	}
	if (best) best.mask = bestMask;
	return best.map((row) => row.map((v) => v === 1));
}

/**
 * Render an inline SVG QR code.
 * @param {string} text
 * @param {{size?:number, margin?:number, dark?:string, light?:string, radius?:number, title?:string}} opts
 */
export function qrSvg(text, opts = {}) {
	const size = opts.size || 132;
	const margin = opts.margin ?? 3;
	const dark = opts.dark || '#0b1220';
	const light = opts.light || '#ffffff';
	const matrix = qrMatrix(text);
	const total = QR_SIZE + margin * 2;
	const path = [];
	for (let y = 0; y < QR_SIZE; y++) {
		for (let x = 0; x < QR_SIZE; x++) {
			if (matrix[y][x]) path.push(`M${x + margin} ${y + margin}h1v1h-1z`);
		}
	}
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="${opts.title || 'QR code'}"><rect width="${total}" height="${total}" fill="${light}"/><path d="${path.join('')}" fill="${dark}"/></svg>`;
}

/** Rasterise the matrix to RGBA (used by the build-time self-test). */
export function qrToRgba(text, scale = 4) {
	const matrix = qrMatrix(text);
	const margin = 4;
	const dim = (QR_SIZE + margin * 2) * scale;
	const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
	for (let y = 0; y < QR_SIZE; y++) {
		for (let x = 0; x < QR_SIZE; x++) {
			if (!matrix[y][x]) continue;
			for (let dy = 0; dy < scale; dy++) {
				for (let dx = 0; dx < scale; dx++) {
					const px = (x + margin) * scale + dx;
					const py = (y + margin) * scale + dy;
					const idx = (py * dim + px) * 4;
					data[idx] = 11;
					data[idx + 1] = 18;
					data[idx + 2] = 32;
					data[idx + 3] = 255;
				}
			}
		}
	}
	return { data, width: dim, height: dim };
}
