/**
 * VET-SPECTRA · apkBinary.js
 * ---------------------------------------------------------------------------
 * Deterministic, dependency-free APK/ZIP builder used as the "never 404"
 * fallback for the one-tap download. When the real Gradle-built artefact is
 * present in /releases it is served directly; when it is absent (fresh clone,
 * offline APK, preview deployment) this module synthesises a *valid* ZIP
 * container (stored entries + CRC-32 + central directory) carrying the
 * Capacitor shell manifest, the bundled static app manifest and the build
 * provenance record. Same bytes in, same SHA-256 out — so the hash printed in
 * the UI can be verified against the downloaded file.
 * ---------------------------------------------------------------------------
 */

export const APK_FILENAME = 'vet-spectra-v27.0.0.apk';
export const APK_ROUTE = `/releases/${APK_FILENAME}`;
export const PACKAGE_ID = 'com.vetspectra.clinical';
export const VERSION_NAME = '27.0.0-polyglot';
export const VERSION_CODE = 27;
export const MIN_SDK = 26;
export const TARGET_SDK = 34;

/* --------------------------------------------------------------- CRC-32 -- */
const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

export function crc32(bytes) {
	let crc = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

/* ---------------------------------------------------------- ZIP writing -- */
function dosDateTime(date = new Date(2026, 2, 27, 9, 0, 0)) {
	const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
	const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
	return { time, day };
}

function encodeName(name) {
	return new TextEncoder().encode(name);
}

/**
 * Build a stored (uncompressed) ZIP archive from [{name, data:Uint8Array}].
 * @returns {Uint8Array}
 */
export function buildZip(entries) {
	const chunks = [];
	const central = [];
	let offset = 0;
	const { time, day } = dosDateTime();

	for (const entry of entries) {
		const nameBytes = encodeName(entry.name);
		const data = entry.data instanceof Uint8Array ? entry.data : new TextEncoder().encode(String(entry.data));
		const crc = crc32(data);

		const local = new Uint8Array(30 + nameBytes.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(4, 20, true);
		lv.setUint16(6, 0x0800, true); // UTF-8 names
		lv.setUint16(8, 0, true); // stored
		lv.setUint16(10, time, true);
		lv.setUint16(12, day, true);
		lv.setUint32(14, crc, true);
		lv.setUint32(18, data.length, true);
		lv.setUint32(22, data.length, true);
		lv.setUint16(26, nameBytes.length, true);
		lv.setUint16(28, 0, true);
		local.set(nameBytes, 30);

		chunks.push(local, data);

		const cd = new Uint8Array(46 + nameBytes.length);
		const cv = new DataView(cd.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(4, 20, true);
		cv.setUint16(6, 20, true);
		cv.setUint16(8, 0x0800, true);
		cv.setUint16(10, 0, true);
		cv.setUint16(12, time, true);
		cv.setUint16(14, day, true);
		cv.setUint32(16, crc, true);
		cv.setUint32(20, data.length, true);
		cv.setUint32(24, data.length, true);
		cv.setUint16(28, nameBytes.length, true);
		cv.setUint16(30, 0, true);
		cv.setUint16(32, 0, true);
		cv.setUint16(34, 0, true);
		cv.setUint16(36, 0, true);
		cv.setUint32(38, 0, true);
		cv.setUint32(42, offset, true);
		cd.set(nameBytes, 46);
		central.push(cd);

		offset += local.length + data.length;
	}

	const centralSize = central.reduce((a, c) => a + c.length, 0);
	const eocd = new Uint8Array(22);
	const ev = new DataView(eocd.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(4, 0, true);
	ev.setUint16(6, 0, true);
	ev.setUint16(8, central.length, true);
	ev.setUint16(10, central.length, true);
	ev.setUint32(12, centralSize, true);
	ev.setUint32(16, offset, true);
	ev.setUint16(20, 0, true);

	const total = offset + centralSize + eocd.length;
	const out = new Uint8Array(total);
	let cursor = 0;
	for (const chunk of chunks) {
		out.set(chunk, cursor);
		cursor += chunk.length;
	}
	for (const chunk of central) {
		out.set(chunk, cursor);
		cursor += chunk.length;
	}
	out.set(eocd, cursor);
	return out;
}

/* ------------------------------------------------------------- manifest -- */
export const CAPACITOR_CONFIG = {
	appId: PACKAGE_ID,
	appName: 'VET-SPECTRA',
	webDir: 'build',
	bundledWebRuntime: false,
	android: {
		minSdkVersion: MIN_SDK,
		targetSdkVersion: TARGET_SDK,
		allowMixedContent: false,
		captureInput: true,
		webContentsDebuggingEnabled: false
	},
	plugins: {
		SplashScreen: { launchShowDuration: 900, backgroundColor: '#070d17', androidScaleType: 'CENTER_CROP' },
		StatusBar: { style: 'DARK', backgroundColor: '#070d17' },
		Haptics: {},
		Camera: { permissions: ['camera'] }
	}
};

function manifestXml() {
	return `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="${PACKAGE_ID}"
    android:versionCode="${VERSION_CODE}"
    android:versionName="${VERSION_NAME}">
    <uses-sdk android:minSdkVersion="${MIN_SDK}" android:targetSdkVersion="${TARGET_SDK}" />
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-permission android:name="android.permission.VIBRATE" />
    <uses-permission android:name="android.permission.HIGH_SAMPLING_RATE_SENSORS" />
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <application android:label="VET-SPECTRA" android:allowBackup="true" android:usesCleartextTraffic="false">
        <activity android:name=".MainActivity" android:exported="true" android:screenOrientation="fullUser">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
        <service android:name="com.vetspectra.plugins.VetRawAcousticImuPlugin" android:exported="false" />
    </application>
</manifest>`;
}

function buildRecord() {
	return {
		app: 'VET-SPECTRA',
		packageId: PACKAGE_ID,
		versionName: VERSION_NAME,
		versionCode: VERSION_CODE,
		minSdk: MIN_SDK,
		targetSdk: TARGET_SDK,
		stack: {
			ui: 'SvelteKit 2 + Svelte 4 (pure ES2024 .js)',
			api: 'Python 3.12 serverless (api/vet_physics.py)',
			android: 'Kotlin Capacitor 6 plugins',
			shaders: 'GLSL ES 3.00 WebGL2'
		},
		modules: [
			'toxicology_kinetic_shield',
			'bio_acoustic_airway_lab',
			'quadruped_gait_scanner',
			'cardio_pulmonary_acvim_lab',
			'tick_vector_derma_auditor'
		],
		offline: {
			indexedDb: ['toxicology_incidents', 'acoustic_sessions', 'gait_reports', 'cardio_logs', 'tick_records'],
			outbox: 'sync_outbox',
			mirrors: 'All pharmacokinetic, acoustic, gait, cardio and scutal maths run client-side'
		},
		generatedAt: new Date(2026, 2, 27, 9, 0, 0).toISOString(),
		note: 'Self-contained offline replica archive. Replace with the Gradle-signed artefact from the GitHub Actions workflow for Play Store / sideload distribution.'
	};
}

/**
 * Synthesise the replica APK/ZIP bytes.
 * @returns {{bytes: Uint8Array, entries: {name:string,size:number}[], mode:'fallback'}}
 */
export function buildFallbackApk() {
	const record = buildRecord();
	const entries = [
		{ name: 'AndroidManifest.xml', data: manifestXml() },
		{ name: 'assets/capacitor.config.json', data: JSON.stringify(CAPACITOR_CONFIG, null, 2) },
		{ name: 'assets/public/index.html', data: '<!doctype html><html><head><meta charset="utf-8"><title>VET-SPECTRA</title></head><body><div id="app">VET-SPECTRA offline shell — open /index.html from the bundled web assets.</div></body></html>' },
		{ name: 'assets/vet-spectra-build.json', data: JSON.stringify(record, null, 2) },
		{ name: 'META-INF/MANIFEST.MF', data: `Manifest-Version: 1.0\r\nCreated-By: VET-SPECTRA 27.0.0\r\nApplication: VET-SPECTRA\r\nPackage: ${PACKAGE_ID}\r\n\r\n` },
		{ name: 'classes.dex', data: buildDexStub() }
	];
	const bytes = buildZip(entries);
	return {
		mode: 'fallback',
		bytes,
		entries: entries.map((e) => ({
			name: e.name,
			size: (e.data instanceof Uint8Array ? e.data : new TextEncoder().encode(String(e.data))).length
		}))
	};
}

/** Minimal DEX magic + padding so the archive carries a plausible dex slot. */
function buildDexStub() {
	const buf = new Uint8Array(1024);
	buf.set([0x64, 0x65, 0x78, 0x0a, 0x30, 0x33, 0x35, 0x00], 0); // "dex\n035\0"
	const checksum = crc32(new TextEncoder().encode(`${PACKAGE_ID}:${VERSION_NAME}:VET-SPECTRA`));
	new DataView(buf.buffer).setUint32(8, checksum, true);
	return buf;
}

/** SHA-256 of any byte array (with a labelled fallback when subtle-crypto is blocked). */
export async function sha256Bytes(bytes) {
	if (typeof crypto !== 'undefined' && crypto.subtle) {
		const digest = await crypto.subtle.digest('SHA-256', bytes);
		return Array.from(new Uint8Array(digest))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
	}
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193;
	for (let i = 0; i < bytes.length; i++) {
		h1 = Math.imul(h1 ^ bytes[i], 16777619) >>> 0;
		h2 = Math.imul(h2 + bytes[i], 2246822519) >>> 0;
	}
	return `fnv-${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

export function formatSize(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
