/**
 * VET-SPECTRA · vetStore.js
 * Global reactive state: RBAC, theme, module routing, hardware permissions,
 * toasts, sync telemetry and the simulated live-patient feed.
 * Pure Svelte stores — no TypeScript.
 */

import { derived, get, writable } from 'svelte/store';
import { saveSetting, loadSetting, vaultStats, flushOutbox } from '$lib/db/indexedDbVetVault.js';

/* =========================================================================
 * RBAC — 3 privilege tiers
 * ========================================================================= */
export const ROLES = [
	{
		key: 'guardian',
		label: 'Guardian',
		fullLabel: 'Pet Guardian (read-only triage)',
		icon: '☗',
		tone: 'cyan',
		blurb: 'Household triage: enter a weight, run the ingestion shield and read the verdict. No clinical writes, no hardware capture, no billing tools.',
		capabilities: ['module.toxicology', 'module.acoustic.read', 'module.gait.read', 'module.cardio.read', 'module.tick.read', 'simulate', 'apk.download']
	},
	{
		key: 'tech',
		label: 'Vet Tech',
		fullLabel: 'Veterinary Technician (clinical capture)',
		icon: '✚',
		tone: 'teal',
		blurb: 'Full clinical capture: microphone, thermal camera, IMU harness, vault writes and sync. Calibration and billing remain locked.',
		capabilities: [
			'module.toxicology',
			'module.acoustic',
			'module.gait',
			'module.cardio',
			'module.tick',
			'simulate',
			'apk.download',
			'hardware.mic',
			'hardware.camera',
			'hardware.imu',
			'hardware.haptics',
			'vault.write',
			'vault.sync'
		]
	},
	{
		key: 'veterinarian',
		label: 'Veterinarian',
		fullLabel: 'Veterinarian / Practice Admin',
		icon: '⚕',
		tone: 'violet',
		blurb: 'Unrestricted: PK parameter calibration, billing auditor, vault export, polyglot admin console and APK build inspector.',
		capabilities: [
			'module.toxicology',
			'module.acoustic',
			'module.gait',
			'module.cardio',
			'module.tick',
			'simulate',
			'apk.download',
			'hardware.mic',
			'hardware.camera',
			'hardware.imu',
			'hardware.haptics',
			'vault.write',
			'vault.sync',
			'vault.export',
			'calibration.edit',
			'billing.audit',
			'admin.polyglot',
			'patients.edit'
		]
	}
];

export function getRole(key) {
	return ROLES.find((r) => r.key === key) || ROLES[0];
}

export function roleCan(roleKey, capability) {
	return getRole(roleKey).capabilities.includes(capability);
}

/* =========================================================================
 * THEMES
 * ========================================================================= */
export const THEMES = [
	{ key: 'obsidian', label: 'Obsidian Surgery', blurb: 'Matte carbon + surgical-teal bioluminescence', gpu: 'full' },
	{ key: 'daylight', label: 'Daylight Clinic', blurb: 'Porcelain light mode for bright exam rooms', gpu: 'full' },
	{ key: 'nocturnal', label: 'Nocturnal Ward', blurb: '630 nm / 405 nm darkroom-safe amber-red', gpu: 'full' },
	{ key: 'eco', label: 'Eco-Glass', blurb: 'Zero-blur opaque fallback for API < 31 & battery saver', gpu: 'eco' }
];

/* =========================================================================
 * MODULES
 * ========================================================================= */
export const MODULES = [
	{ key: 'toxicology', index: 1, label: 'Tox Shield', title: 'Toxicology Kinetic Shield', icon: '⚗', tone: 'coral' },
	{ key: 'acoustic', index: 2, label: 'Airway Lab', title: 'Bio-Acoustic Airway Lab', icon: '◉', tone: 'cyan' },
	{ key: 'gait', index: 3, label: 'Gait Lab', title: 'Quadruped Gait Scanner', icon: '⌇', tone: 'teal' },
	{ key: 'cardio', index: 4, label: 'ACVIM Cardio', title: 'Cardio-Pulmonary ACVIM Lab', icon: '♥', tone: 'violet' },
	{ key: 'tick', index: 5, label: 'Tick & Quote', title: 'Tick Vector & Derma Auditor', icon: '✚', tone: 'amber' }
];

/* =========================================================================
 * STORES
 * ========================================================================= */
export const theme = writable('obsidian');
export const role = writable('tech');
export const activeModule = writable('toxicology');
export const viewMode = writable('desktop'); // 'desktop' | 'frame'
export const modal = writable(null); // null | 'apk' | 'gatekeeper' | 'polyglot' | 'vault'
export const isOnline = writable(true);
export const syncState = writable({ queued: 0, synced: 0, lastSync: null, busy: false, adapter: 'indexeddb', total: 0 });
export const permissions = writable({
	mic: 'idle', // idle | granted | denied | simulated
	camera: 'idle',
	imu: 'idle',
	haptics: 'idle',
	storage: 'idle'
});
export const toasts = writable([]);
export const patient = writable({ name: 'Bramble', species: 'dog', breed: 'Beagle', weightKg: 12, ageYears: 4 });
export const booted = writable(false);
export const ecoMode = derived(theme, ($t) => $t === 'eco');

/** Live feed consumed by the GLSL underlay (heart rate, audio energy, toxin load). */
export const vitals = writable({ hr: 96, energy: 0.12, toxicity: 0 });

export function bumpVitals(patch) {
	vitals.update((v) => ({ ...v, ...patch }));
}

/* toasts ------------------------------------------------------------------ */
let toastId = 0;
export function pushToast(message, kind = 'ok', ttl = 4200) {
	const id = ++toastId;
	toasts.update((list) => [...list.slice(-3), { id, message, kind }]);
	if (ttl > 0 && typeof window !== 'undefined') {
		setTimeout(() => dismissToast(id), ttl);
	}
	return id;
}

export function dismissToast(id) {
	toasts.update((list) => list.filter((t) => t.id !== id));
}

/* permissions ------------------------------------------------------------- */
export function setPermission(key, value) {
	permissions.update((p) => ({ ...p, [key]: value }));
}

export function can(capability) {
	return roleCan(get(role), capability);
}

/* theme / role persistence ------------------------------------------------ */
export async function hydratePreferences() {
	try {
		const savedTheme = await loadSetting('theme', null);
		const savedRole = await loadSetting('role', null);
		const savedView = await loadSetting('viewMode', null);
		if (savedTheme) theme.set(savedTheme);
		if (savedRole) role.set(savedRole);
		if (savedView) viewMode.set(savedView);
	} catch {
		/* first boot */
	}
}

export async function persistTheme(key) {
	theme.set(key);
	document.documentElement.setAttribute('data-theme', key);
	document.documentElement.setAttribute('data-gpu', THEMES.find((t) => t.key === key)?.gpu || 'full');
	try {
		await saveSetting('theme', key);
	} catch {
		/* non-fatal */
	}
}

export async function persistRole(key) {
	role.set(key);
	try {
		await saveSetting('role', key);
	} catch {
		/* non-fatal */
	}
	pushToast(`Privilege tier → ${getRole(key).fullLabel}`, 'ok');
}

export async function persistViewMode(mode) {
	viewMode.set(mode);
	try {
		await saveSetting('viewMode', mode);
	} catch {
		/* non-fatal */
	}
}

/* sync -------------------------------------------------------------------- */
export async function refreshSyncState() {
	try {
		const stats = await vaultStats();
		syncState.update((s) => ({
			...s,
			queued: stats.queued,
			synced: stats.synced,
			total: stats.total,
			adapter: stats.kind
		}));
		return stats;
	} catch {
		return null;
	}
}

export async function triggerSync() {
	syncState.update((s) => ({ ...s, busy: true }));
	try {
		const res = await flushOutbox({ force: true });
		await refreshSyncState();
		syncState.update((s) => ({ ...s, lastSync: new Date().toISOString() }));
		if (res.offline) pushToast('Offline — records kept in the local vault', 'warn');
		else if (res.flushed > 0) pushToast(`Synced ${res.flushed} record${res.flushed === 1 ? '' : 's'} to the Python API`, 'ok');
		else if (res.remaining > 0) pushToast(`${res.remaining} record(s) still queued — will retry automatically`, 'warn');
		else pushToast('Vault already in sync', 'ok');
	} catch {
		pushToast('Sync failed — records remain safe in IndexedDB', 'bad');
	} finally {
		syncState.update((s) => ({ ...s, busy: false }));
	}
}

/* navigation -------------------------------------------------------------- */
export function goToModule(key) {
	activeModule.set(key);
	if (typeof window !== 'undefined') {
		const el = document.querySelector('.workstation');
		if (el) el.scrollTo({ top: 0, behavior: 'smooth' });
	}
}

export function openModal(name) {
	modal.set(name);
}

export function closeModal() {
	modal.set(null);
}

/* boot -------------------------------------------------------------------- */
export function markBooted() {
	booted.set(true);
}
