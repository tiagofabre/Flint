import { describe, it, expect } from 'vitest';
import * as E from 'fp-ts/Either';
import { FlintPluginSettingsSchema, DEFAULT_SETTINGS, parseSettings } from '../flint-settings';

// flint-settings imports from 'firebase-tools' and 'main' at module scope via
// other imports, so stub the modules that would fail in a test environment.
import { vi } from 'vitest';

vi.mock('firebase-tools', () => ({
	requireFirebaseState: vi.fn(),
	getFirebaseAuth: vi.fn(),
	withTimeout: vi.fn(),
}));

vi.mock('main', () => ({
	default: class FlintPlugin {},
}));

vi.mock('obsidian', () => ({
	App: class {},
	PluginSettingTab: class { app: any; plugin: any; containerEl: any; },
	Setting: class {
		setName() { return this; }
		setDesc() { return this; }
		setHeading() { return this; }
		setTooltip() { return this; }
		addText() { return this; }
		addButton() { return this; }
		addToggle() { return this; }
		addDropdown() { return this; }
	},
	Modal: class { app: any; titleEl: any; contentEl: any; open() {} close() {} onClose() {} },
	ButtonComponent: class {},
	setIcon: vi.fn(),
}));

vi.mock('firebase/storage', () => ({
	listAll: vi.fn(),
}));

vi.mock('firebase/auth', () => ({
	signInWithEmailAndPassword: vi.fn(),
	createUserWithEmailAndPassword: vi.fn(),
	signOut: vi.fn(),
}));

vi.mock('errors', async () => {
	const actual = await vi.importActual<typeof import('../errors')>('../errors');
	return actual;
});

describe('FlintPluginSettingsSchema', () => {
	it('parses empty object with all defaults', () => {
		const result = FlintPluginSettingsSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.remoteConnectedVault).toBe('default');
			expect(result.data.syncOnStartup).toBe(true);
			expect(result.data.scheduledSyncEnabled).toBe(false);
			expect(result.data.scheduledSyncIntervalMinutes).toBe(5);
			expect(result.data.firstSyncDone).toBe(false);
		}
	});

	it('rejects scheduledSyncIntervalMinutes < 1', () => {
		const result = FlintPluginSettingsSchema.safeParse({ scheduledSyncIntervalMinutes: 0 });
		expect(result.success).toBe(false);
	});

	it('rejects non-boolean syncOnStartup', () => {
		const result = FlintPluginSettingsSchema.safeParse({ syncOnStartup: 'yes' });
		expect(result.success).toBe(false);
	});
});

describe('DEFAULT_SETTINGS', () => {
	it('has all required keys', () => {
		const keys: Array<keyof typeof DEFAULT_SETTINGS> = [
			'remoteConnectedVault', 'userEmail', 'firebaseApiKey', 'firebaseAuthDomain',
			'firebaseStorageBucket', 'firebaseProjectId', 'firebaseMessagingSenderId',
			'firebaseAppId', 'deviceId', 'syncOnStartup', 'syncOnFileChange',
			'scheduledSyncEnabled', 'scheduledSyncIntervalMinutes', 'firstSyncDone',
		];
		for (const k of keys) {
			expect(DEFAULT_SETTINGS).toHaveProperty(k);
		}
	});
});

describe('parseSettings', () => {
	it('returns Right with full valid data', () => {
		const result = parseSettings({
			remoteConnectedVault: 'my-vault',
			syncOnStartup: false,
			scheduledSyncIntervalMinutes: 10,
		});
		expect(E.isRight(result)).toBe(true);
		if (E.isRight(result)) {
			expect(result.right.remoteConnectedVault).toBe('my-vault');
			expect(result.right.syncOnStartup).toBe(false);
			expect(result.right.scheduledSyncIntervalMinutes).toBe(10);
		}
	});

	it('returns Right for null/undefined (falls back to defaults)', () => {
		expect(E.isRight(parseSettings(null))).toBe(true);
		expect(E.isRight(parseSettings(undefined))).toBe(true);
	});

	it('returns Right for partial data (merges with defaults)', () => {
		const result = parseSettings({ userEmail: 'test@example.com' });
		expect(E.isRight(result)).toBe(true);
		if (E.isRight(result)) {
			expect(result.right.userEmail).toBe('test@example.com');
			expect(result.right.syncOnStartup).toBe(true); // default
		}
	});

	it('returns Left for invalid field types', () => {
		const result = parseSettings({ scheduledSyncIntervalMinutes: -5 });
		expect(E.isLeft(result)).toBe(true);
		if (E.isLeft(result)) {
			expect(result.left._tag).toBe('SettingsError');
		}
	});
});
