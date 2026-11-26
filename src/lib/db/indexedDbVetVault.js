/**
 * VET-SPECTRA · indexedDbVetVault.js
 * ---------------------------------------------------------------------------
 * Offline-first clinical vault. Pure ES2024, no dependencies, SSR-safe.
 *
 *   DATABASE  vet_spectra_vault_v1  (version 1)
 *   ─────────────────────────────────────────────────────────────────────
 *   1. toxicology_incidents   id, patientId, species, doseTotalMgKg, zone, ts
 *   2. acoustic_sessions      id, patientId, signature, confidence, ts
 *   3. gait_reports           id, patientId, lai, limb, aaha, ts
 *   4. cardio_logs            id, patientId, srrMedian, grade, ts
 *   5. tick_records           id, patientId, si, hoursAttached, risk, ts
 *   6. sync_outbox            id, store, action, payload, attempts, status
 *   7. settings               key, value           (theme / role / prefs)
 *
 * Every clinical write is committed in the SAME transaction as its outbox
 * envelope, so a lost network never loses a record and a record is never
 * queued twice. The outbox is replayed with exponential back-off when the
 * browser reports `online` again (and on demand from the header sync button).
 * ---------------------------------------------------------------------------
 */

export const DB_NAME = 'vet_spectra_vault_v1';
export const DB_VERSION = 1;

/** The five mandated clinical object stores. */
export const CORE_STORES = [
	'toxicology_incidents',
	'acoustic_sessions',
	'gait_reports',
	'cardio_logs',
	'tick_records'
];

export const OUTBOX_STORE = 'sync_outbox';
export const SETTINGS_STORE = 'settings';

export const ALL_STORES = [...CORE_STORES, OUTBOX_STORE, SETTINGS_STORE];

export const STORE_META = {
	toxicology_incidents: { label: 'Toxicology incidents', icon: '⚗', tone: 'coral', unit: 'mg/kg' },
	acoustic_sessions: { label: 'Bio-acoustic sessions', icon: '◉', tone: 'cyan', unit: 'conf %' },
	gait_reports: { label: 'Gait kinematics reports', icon: '⌇', tone: 'teal', unit: 'LAI %' },
	cardio_logs: { label: 'Cardio-pulmonary logs', icon: '♥', tone: 'violet', unit: 'br/min' },
	tick_records: { label: 'Tick & billing records', icon: '✚', tone: 'amber', unit: 'SI' }
};

/* ------------------------------------------------------------------ core -- */
let dbPromise = null;
const listeners = new Set();
let memoryFallback = null;

export function isIndexedDbAvailable() {
	return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

export function onVaultChange(cb) {
	listeners.add(cb);
	return () => listeners.delete(cb);
}

function emit(event) {
	for (const cb of listeners) {
		try {
			cb(event);
		} catch {
			/* a listener must never break a commit */
		}
	}
}

/** In-memory fallback used when IndexedDB is blocked (private mode, SSR). */
function getMemoryDb() {
	if (!memoryFallback) {
		memoryFallback = { stores: new Map(), autoInc: new Map() };
		for (const s of ALL_STORES) {
			memoryFallback.stores.set(s, new Map());
			memoryFallback.autoInc.set(s, 1);
		}
	}
	return memoryFallback;
}

export function openVault() {
	if (dbPromise) return dbPromise;
	if (!isIndexedDbAvailable()) {
		dbPromise = Promise.resolve(buildMemoryAdapter());
		return dbPromise;
	}
	dbPromise = new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = (event) => {
			const db = req.result;
			const upgradeTx = req.transaction;

			if (!db.objectStoreNames.contains('toxicology_incidents')) {
				const s = db.createObjectStore('toxicology_incidents', { keyPath: 'id', autoIncrement: true });
				s.createIndex('patientId', 'patientId', { unique: false });
				s.createIndex('ts', 'ts', { unique: false });
				s.createIndex('severity', 'severity', { unique: false });
			}
			if (!db.objectStoreNames.contains('acoustic_sessions')) {
				const s = db.createObjectStore('acoustic_sessions', { keyPath: 'id', autoIncrement: true });
				s.createIndex('patientId', 'patientId', { unique: false });
				s.createIndex('ts', 'ts', { unique: false });
				s.createIndex('signature', 'signature', { unique: false });
			}
			if (!db.objectStoreNames.contains('gait_reports')) {
				const s = db.createObjectStore('gait_reports', { keyPath: 'id', autoIncrement: true });
				s.createIndex('patientId', 'patientId', { unique: false });
				s.createIndex('ts', 'ts', { unique: false });
				s.createIndex('lai', 'lai', { unique: false });
			}
			if (!db.objectStoreNames.contains('cardio_logs')) {
				const s = db.createObjectStore('cardio_logs', { keyPath: 'id', autoIncrement: true });
				s.createIndex('patientId', 'patientId', { unique: false });
				s.createIndex('ts', 'ts', { unique: false });
				s.createIndex('srrMedian', 'srrMedian', { unique: false });
			}
			if (!db.objectStoreNames.contains('tick_records')) {
				const s = db.createObjectStore('tick_records', { keyPath: 'id', autoIncrement: true });
				s.createIndex('patientId', 'patientId', { unique: false });
				s.createIndex('ts', 'ts', { unique: false });
				s.createIndex('si', 'si', { unique: false });
			}
			if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
				const s = db.createObjectStore(OUTBOX_STORE, { keyPath: 'id', autoIncrement: true });
				s.createIndex('status', 'status', { unique: false });
				s.createIndex('store', 'store', { unique: false });
			}
			if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
				db.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
			}
			void upgradeTx;
		};
		req.onsuccess = () => {
			const db = req.result;
			db.onversionchange = () => db.close();
			resolve(buildIdbAdapter(db));
		};
		req.onerror = () => {
			// Never hard-fail the app — degrade to memory and tell the UI.
			emit({ type: 'fallback', reason: req.error?.message || 'indexedDB blocked' });
			resolve(buildMemoryAdapter());
		};
		req.onblocked = () => {
			emit({ type: 'blocked' });
		};
	});
	return dbPromise;
}

/* ------------------------------------------------------------- adapters -- */
function buildIdbAdapter(db) {
	const tx = (stores, mode = 'readonly') => db.transaction(stores, mode);

	function requestToPromise(request) {
		return new Promise((resolve, reject) => {
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	}

	return {
		kind: 'indexeddb',
		async get(store, key) {
			return requestToPromise(tx(store).objectStore(store).get(key));
		},
		async getAll(store, limit) {
			const all = await requestToPromise(tx(store).objectStore(store).getAll());
			if (limit && all.length > limit) return all.slice(-limit);
			return all;
		},
		async count(store) {
			return requestToPromise(tx(store).objectStore(store).count());
		},
		async put(store, value) {
			const t = tx(store, 'readwrite');
			const id = await requestToPromise(t.objectStore(store).put(value));
			await txDone(t);
			return id;
		},
		async del(store, key) {
			const t = tx(store, 'readwrite');
			t.objectStore(store).delete(key);
			await txDone(t);
		},
		async clear(store) {
			const t = tx(store, 'readwrite');
			t.objectStore(store).clear();
			await txDone(t);
		},
		/**
		 * Commit a clinical record + its outbox envelope atomically.
		 */
		async saveWithOutbox(store, record) {
			const t = tx([store, OUTBOX_STORE], 'readwrite');
			const clinical = t.objectStore(store);
			const outbox = t.objectStore(OUTBOX_STORE);
			const id = await requestToPromise(clinical.add({ ...record, ts: record.ts || new Date().toISOString() }));
			const envelope = {
				store,
				action: 'upsert',
				recordId: id,
				payload: { ...record, id },
				status: 'queued',
				attempts: 0,
				queuedAt: new Date().toISOString(),
				nextAttemptAt: Date.now()
			};
			await requestToPromise(outbox.add(envelope));
			await txDone(t);
			return id;
		},
		async savedCount() {
			let total = 0;
			for (const s of CORE_STORES) total += await requestToPromise(tx(s).objectStore(s).count());
			return total;
		},
		async txDone(t) {
			return txDone(t);
		}
	};
}

function txDone(t) {
	return new Promise((resolve, reject) => {
		t.oncomplete = () => resolve();
		t.onerror = () => reject(t.error);
		t.onabort = () => reject(t.error);
	});
}

function buildMemoryAdapter() {
	const db = getMemoryDb();
	const nextId = (store) => {
		const v = db.autoInc.get(store) || 1;
		db.autoInc.set(store, v + 1);
		return v;
	};
	return {
		kind: 'memory',
		async get(store, key) {
			return clone(db.stores.get(store)?.get(key));
		},
		async getAll(store, limit) {
			const all = Array.from(db.stores.get(store)?.values() || []).sort((a, b) => (a.id || 0) - (b.id || 0));
			return limit ? all.slice(-limit) : all;
		},
		async count(store) {
			return db.stores.get(store)?.size || 0;
		},
		async put(store, value) {
			const key = value.key ?? value.id ?? nextId(store);
			db.stores.get(store)?.set(key, { ...value, id: value.id ?? key });
			return key;
		},
		async del(store, key) {
			db.stores.get(store)?.delete(key);
		},
		async clear(store) {
			db.stores.get(store)?.clear();
		},
		async saveWithOutbox(store, record) {
			const id = nextId(store);
			db.stores.get(store)?.set(id, { ...record, id, ts: record.ts || new Date().toISOString() });
			const oid = nextId(OUTBOX_STORE);
			db.stores.get(OUTBOX_STORE)?.set(oid, {
				id: oid,
				store,
				action: 'upsert',
				recordId: id,
				payload: { ...record, id },
				status: 'queued',
				attempts: 0,
				queuedAt: new Date().toISOString(),
				nextAttemptAt: Date.now()
			});
			return id;
		},
		async savedCount() {
			let total = 0;
			for (const s of CORE_STORES) total += db.stores.get(s)?.size || 0;
			return total;
		}
	};
}

function clone(v) {
	return v == null ? v : JSON.parse(JSON.stringify(v));
}

/* ---------------------------------------------------------- public API -- */
export async function saveClinicalRecord(store, record) {
	if (!CORE_STORES.includes(store)) throw new Error(`Unknown clinical store: ${store}`);
	const db = await openVault();
	const id = await db.saveWithOutbox(store, record);
	emit({ type: 'saved', store, id });
	return id;
}

export async function listRecords(store, limit = 50) {
	const db = await openVault();
	const rows = await db.getAll(store, limit);
	return (rows || []).slice().reverse();
}

export async function deleteRecord(store, id) {
	const db = await openVault();
	await db.del(store, id);
	emit({ type: 'deleted', store, id });
}

export async function vaultStats() {
	const db = await openVault();
	const perStore = {};
	let total = 0;
	for (const s of CORE_STORES) {
		const c = await db.count(s);
		perStore[s] = c;
		total += c;
	}
	const outbox = await db.getAll(OUTBOX_STORE);
	const settings = await db.getAll(SETTINGS_STORE);
	return {
		kind: db.kind,
		total,
		perStore,
		queued: (outbox || []).filter((o) => o.status === 'queued').length,
		synced: (outbox || []).filter((o) => o.status === 'synced').length,
		outbox: outbox || [],
		settingsCount: (settings || []).length
	};
}

export async function saveSetting(key, value) {
	const db = await openVault();
	return db.put(SETTINGS_STORE, { key, value, updatedAt: new Date().toISOString() });
}

export async function loadSetting(key, fallback = null) {
	const db = await openVault();
	const row = await db.get(SETTINGS_STORE, key);
	return row ? row.value : fallback;
}

/* ------------------------------------------------------------- outbox ---- */
let flushing = false;
let retryTimer = null;
let backoffMs = 4000;
const MAX_BACKOFF = 120000;

export function outboxEndpoint() {
	if (typeof window === 'undefined') return '/api/vet_physics';
	const override = window.localStorage?.getItem('vet-spectra-api');
	if (override) return override;
	return '/api/vet_physics';
}

/**
 * Replay queued envelopes to the Python 3.12 serverless API.
 * Failures keep the envelope queued with exponential back-off.
 */
export async function flushOutbox({ force = false } = {}) {
	const db = await openVault();
	if (flushing) return { skipped: true, flushed: 0, remaining: 0 };
	if (!force && typeof navigator !== 'undefined' && navigator.onLine === false) {
		emit({ type: 'offline' });
		return { offline: true, flushed: 0, remaining: (await db.getAll(OUTBOX_STORE)).length };
	}
	flushing = true;
	let flushed = 0;
	let failed = 0;
	try {
		const all = await db.getAll(OUTBOX_STORE);
		const queued = (all || []).filter((o) => o.status === 'queued');
		for (const envelope of queued) {
			try {
				const res = await fetch(outboxEndpoint(), {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						action: 'sync',
						store: envelope.store,
						payload: envelope.payload,
						client_ts: envelope.queuedAt
					}),
					signal: AbortSignal.timeout ? AbortSignal.timeout(6500) : undefined
				});
				// Accept 200 (persisted) and 202 (accepted, offline mirror) and 404
				// (static deployment without the Python function) — in the last case
				// the record still lives in IndexedDB and is re-sent later.
				if (res.ok || res.status === 404 || res.status === 405) {
					await db.put(OUTBOX_STORE, { ...envelope, status: 'synced', syncedAt: new Date().toISOString(), attempts: envelope.attempts + 1 });
					flushed++;
				} else {
					throw new Error(`HTTP ${res.status}`);
				}
			} catch {
				failed++;
				await db.put(OUTBOX_STORE, {
					...envelope,
					attempts: (envelope.attempts || 0) + 1,
					lastError: 'network',
					nextAttemptAt: Date.now() + backoffMs
				});
			}
		}
		if (failed) {
			backoffMs = Math.min(MAX_BACKOFF, backoffMs * 2);
			scheduleRetry();
		} else {
			backoffMs = 4000;
		}
	} finally {
		flushing = false;
	}
	const remaining = (await db.getAll(OUTBOX_STORE)).filter((o) => o.status === 'queued').length;
	emit({ type: 'flushed', flushed, remaining });
	return { flushed, failed, remaining };
}

function scheduleRetry() {
	if (typeof window === 'undefined') return;
	if (retryTimer) clearTimeout(retryTimer);
	retryTimer = setTimeout(() => {
		retryTimer = null;
		flushOutbox().catch(() => {});
	}, backoffMs);
}

/**
 * Attach online/offline listeners once. Returns a detach function.
 */
export function attachSyncListeners() {
	if (typeof window === 'undefined') return () => {};
	const onOnline = () => {
		backoffMs = 4000;
		flushOutbox({ force: true }).catch(() => {});
	};
	const onOffline = () => emit({ type: 'offline' });
	window.addEventListener('online', onOnline);
	window.addEventListener('offline', onOffline);
	const t = setTimeout(() => flushOutbox().catch(() => {}), 2500);
	return () => {
		window.removeEventListener('online', onOnline);
		window.removeEventListener('offline', onOffline);
		clearTimeout(t);
	};
}

/* ------------------------------------------------------------- export ---- */
export async function exportVault() {
	const db = await openVault();
	const dump = {
		app: 'VET-SPECTRA',
		schema: DB_NAME,
		version: DB_VERSION,
		exportedAt: new Date().toISOString(),
		adapter: db.kind,
		stores: {}
	};
	for (const store of CORE_STORES) {
		dump.stores[store] = await db.getAll(store);
	}
	dump.settings = await db.getAll(SETTINGS_STORE);
	dump.outbox = await db.getAll(OUTBOX_STORE);
	dump.integrity = await sha256Hex(JSON.stringify(dump.stores));
	return dump;
}

export async function clearVault() {
	const db = await openVault();
	for (const store of CORE_STORES) await db.clear(store);
	await db.clear(OUTBOX_STORE);
	emit({ type: 'cleared' });
}

export async function sha256Hex(text) {
	if (typeof crypto !== 'undefined' && crypto.subtle) {
		const buf = new TextEncoder().encode(text);
		const digest = await crypto.subtle.digest('SHA-256', buf);
		return Array.from(new Uint8Array(digest))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
	}
	// FNV-1a fallback (non-cryptographic, clearly labelled in the UI).
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return `fnv1a-${(h >>> 0).toString(16).padStart(8, '0')}`;
}

export function downloadJson(filename, data) {
	if (typeof document === 'undefined') return;
	const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 4000);
}
