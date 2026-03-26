import { App, Modal, Notice, Plugin, SuggestModal, TAbstractFile, TFile, debounce } from 'obsidian';
import { listAll } from 'firebase/storage';
import { onAuthStateChanged } from 'firebase/auth';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import * as T from 'fp-ts/Task';
import { FlintDataTransfer, SyncSummary } from 'datatools';
import { setupFirebase, setUserVaultRef, getFirebaseAuth, requireFirebaseState, withTimeout } from 'firebase-tools';
import { FlintPluginSettings, FlintSettingsTab, DEFAULT_SETTINGS, parseSettings } from 'flint-settings';
import { FlintError, mkSettings, displayError, isUnauthenticatedError } from 'errors';
import { initAutomerge } from 'crdt';

export let currentVaultName: string = 'vaults';
export let remoteVaultName: string = '';

export default class FlintPlugin extends Plugin {
	settings: FlintPluginSettings;
	statusBar: HTMLElement;
	syncRibbon: HTMLElement;
	dataTools: FlintDataTransfer;

	private readonly debouncedSync = debounce(() => {
		if (!this.settings.userEmail || !this.settings.syncOnFileChange) return;
		// Drop file-change events that arrive while a sync is already running —
		// those events are usually caused by Flint writing remote files locally,
		// and queuing a follow-up sync would create an infinite loop.
		if (this.isSyncing) return;
		void this.runSync()();
	}, 5000, true);

	private isSyncing = false;
	private lastSyncUserId: string | null = null;
	private unsubscribeAuth: (() => void) | null = null;

	setSyncing(syncing: boolean): void {
		if (syncing) {
			this.syncRibbon.addClass('flint-syncing');
			this.statusBar.setText('Flint: syncing…');
		} else {
			this.syncRibbon.removeClass('flint-syncing');
			const v = this.settings.remoteConnectedVault;
			this.statusBar.setText(v !== 'default' ? `Flint remote set to ${v}` : 'Flint remote not set');
		}
	}

	private releaseSyncLock(): void {
		this.isSyncing = false;
		this.setSyncing(false);
	}

	runSync(): TE.TaskEither<FlintError, SyncSummary> {
		if (this.isSyncing) return TE.left(mkSettings('lock', 'Sync already in progress'));
		this.isSyncing = true;
		this.setSyncing(true);
		return async () => {
			const result = await this.dataTools.syncAll(this.app.vault, this.settings)();
			this.releaseSyncLock();
			if (E.isLeft(result)) {
				if (result.left._tag === 'UserCancelledError') {
					new Notice('Sync cancelled.');
				} else if (isUnauthenticatedError(result.left)) {
					// Expected when not signed in — suppress silently
				} else {
					new Notice(`Sync failed: ${displayError(result.left)}`);
					await this.logError('Sync', result.left)();
				}
			} else {
				const { synced, skipped, errors } = result.right;
				new Notice(
					errors.length > 0
						? `Sync done — ${synced} synced, ${skipped} skipped, ${errors.length} errors`
						: `Sync done — ${synced} synced, ${skipped} unchanged`
				);
			}
			return result;
		};
	}

	logError(context: string, err: unknown): T.Task<void> {
		return async () => {
			const ts = new Date().toLocaleString();
			const msg = err !== null && typeof err === 'object' && '_tag' in err
				? displayError(err as FlintError)
				: (err instanceof Error ? err.message : String(err));
			const line = `- ${ts} | ${context} | ${msg}\n`;
			const logPath = 'flint-logs.md';
			try {
				const adapter = this.app.vault.adapter;
				if (await adapter.exists(logPath)) {
					const existing = await adapter.read(logPath);
					await adapter.write(logPath, existing + line);
				} else {
					await adapter.write(logPath, `# Flint Logs\n\n${line}`);
				}
			} catch {
				console.error('[Flint] Failed to write log:', line);
				new Notice('Flint: could not write to flint-logs.md — check disk/permissions');
			}
		};
	}

	private scheduledSyncHandle: number | null = null;

	setupScheduledSync() {
		if (this.scheduledSyncHandle !== null) {
			window.clearInterval(this.scheduledSyncHandle);
			this.scheduledSyncHandle = null;
		}
		if (this.settings.scheduledSyncEnabled && this.settings.userEmail) {
			const ms = this.settings.scheduledSyncIntervalMinutes * 60 * 1000;
			this.scheduledSyncHandle = window.setInterval(() => {
				void this.runSync()();
			}, ms);
		}
	}

	setupFirebaseAndAuth(): void {
		if (!this.settings.firebaseApiKey) return;

		this.unsubscribeAuth?.();
		this.unsubscribeAuth = null;

		const setupResult = setupFirebase({
			apiKey: this.settings.firebaseApiKey,
			authDomain: this.settings.firebaseAuthDomain,
			storageBucket: this.settings.firebaseStorageBucket,
			projectId: this.settings.firebaseProjectId,
			messagingSenderId: this.settings.firebaseMessagingSenderId,
			appId: this.settings.firebaseAppId,
		});
		if (E.isLeft(setupResult)) {
			new Notice(`Firebase config error: ${displayError(setupResult.left)}`);
			void this.logError('Firebase setup', setupResult.left)();
			return;
		}

		const authResult = getFirebaseAuth();
		if (E.isLeft(authResult)) {
			new Notice(`Firebase auth error: ${displayError(authResult.left)}`);
			void this.logError('Firebase auth init', authResult.left)();
			return;
		}

		this.unsubscribeAuth = onAuthStateChanged(authResult.right, (user) => {
			// onAuthStateChanged is a Firebase API — callback must be void, not TaskEither.
			// We execute a T.Task<void> here so errors are always handled.
			void this.handleAuthStateChange(user)();
		});
	}

	private handleAuthStateChange(user: { uid: string; email: string | null } | null): T.Task<void> {
		return async () => {
			if (user) {
				const isNewLogin = user.uid !== this.lastSyncUserId;
				this.lastSyncUserId = user.uid;
				this.settings.userEmail = user.email ?? '';

				const setRefResult = setUserVaultRef(user.uid);
				if (E.isLeft(setRefResult)) {
					new Notice(`Flint: ${displayError(setRefResult.left)}`);
					void this.logError('Set vault ref', setRefResult.left)();
					return;
				}

				if (isNewLogin) {
					if (!this.settings.firstSyncDone) {
						new FirstSyncModal(this.app, this).open();
					} else if (this.settings.syncOnStartup) {
						const r = await this.runSync()();
						if (E.isLeft(r) && r.left._tag !== 'UserCancelledError') {
							void this.logError('Startup sync', r.left)();
						}
					}
					this.setupScheduledSync();
				}
			} else {
				this.lastSyncUserId = null;
				this.settings.userEmail = '';
				this.setupScheduledSync(); // clears the interval on sign-out
			}
			await this.saveSettings();
		};
	}

	async onload() {
		await initAutomerge();
		await this.loadSettings();
		currentVaultName = this.app.vault.getName();
		remoteVaultName = this.settings.remoteConnectedVault;
		this.dataTools = new FlintDataTransfer(this);

		// Generate a stable device ID if not yet assigned
		if (!this.settings.deviceId) {
			this.settings.deviceId = crypto.randomUUID();
			await this.saveSettings();
		}

		// Ribbon and status bar must be set up before the auth listener fires
		// (onAuthStateChanged can fire immediately with a cached token).
		this.syncRibbon = this.addRibbonIcon('refresh-cw', 'Sync vault', (_evt: MouseEvent) => {
			if (!this.settings.userEmail) {
				new Notice('Please sign in first (Flint settings)');
				return;
			}
			void this.runSync()();
		});
		this.syncRibbon.addClass('flint-sync-ribbon-class');

		this.statusBar = this.addStatusBarItem();
		if (this.settings.remoteConnectedVault !== 'default') {
			this.statusBar.setText(`Flint remote set to ${this.settings.remoteConnectedVault}`);
		} else {
			this.statusBar.setText('Flint remote not set');
		}

		this.setupFirebaseAndAuth();

		// Sync on local file changes (debounced — all events share the same timer)
		this.registerEvent(
			this.app.vault.on('modify', (file: TAbstractFile) => {
				if (file instanceof TFile && file.extension === 'md') this.debouncedSync();
			})
		);
		this.registerEvent(
			this.app.vault.on('create', (file: TAbstractFile) => {
				if (file instanceof TFile && file.extension === 'md') this.debouncedSync();
			})
		);
		this.registerEvent(
			this.app.vault.on('delete', (file: TAbstractFile) => {
				if (file instanceof TFile && file.extension === 'md') this.debouncedSync();
			})
		);

		this.addCommand({
			id: 'import-cloud-vault',
			name: 'Import vault from cloud',
			callback: () => {
				if (!this.settings.userEmail) {
					new Notice('Please sign in first (Flint settings)');
					return;
				}
				const selectionModal = new CloudVaultSelectModal(this.app, this.statusBar, this, this.settings);
				selectionModal.open();
			}
		});

		this.addCommand({
			id: 'force-push',
			name: 'Force push (overwrite remote)',
			checkCallback: (checking: boolean) => {
				if (!this.settings.userEmail) return false;
				if (!checking) {
					if (this.isSyncing) {
						new Notice('A sync is already in progress. Please wait.');
						return;
					}
					this.isSyncing = true;
					this.setSyncing(true);
					new Notice('Force push: clearing remote and re-uploading everything…');
					void (async () => {
						const result = await this.dataTools.forcePush(this.app.vault, this.settings)();
						this.releaseSyncLock();
						if (E.isLeft(result)) {
							new Notice(`Force push failed: ${displayError(result.left)}`);
							void this.logError('Force push', result.left)();
						} else {
							new Notice('Force push complete');
						}
					})();
				}
				return true;
			}
		});

		this.addCommand({
			id: 'force-pull',
			name: 'Force pull (overwrite local with remote)',
			checkCallback: (checking: boolean) => {
				if (!this.settings.userEmail) return false;
				if (!checking) {
					if (this.isSyncing) {
						new Notice('A sync is already in progress. Please wait.');
						return;
					}
					this.isSyncing = true;
					this.setSyncing(true);
					new Notice('Force pull: deleting local files and downloading from remote…');
					void (async () => {
						const result = await this.dataTools.forcePull(this.app.vault, this.settings)();
						this.releaseSyncLock();
						if (E.isLeft(result)) {
							new Notice(`Force pull failed: ${displayError(result.left)}`);
							void this.logError('Force pull', result.left)();
						} else {
							new Notice('Force pull complete');
						}
					})();
				}
				return true;
			}
		});

		this.addSettingTab(new FlintSettingsTab(this.app, this));
	}

	async setRemoteDestination(remoteName: string) {
		remoteVaultName = remoteName;
		this.settings.remoteConnectedVault = remoteName;
		this.settings.firstSyncDone = false;
		this.statusBar.setText(`Flint remote set to ${remoteName}`);
		new Notice(`Syncing to ${remoteName}`);
		await this.saveSettings();
	}

	onunload() {
		if (this.scheduledSyncHandle !== null) {
			window.clearInterval(this.scheduledSyncHandle);
			this.scheduledSyncHandle = null;
		}
		this.unsubscribeAuth?.();
	}

	async loadSettings() {
		const raw: unknown = await this.loadData();
		const result = parseSettings(raw);
		if (E.isRight(result)) {
			this.settings = result.right;
		} else {
			console.warn('[Flint] Settings parse error, using defaults:', result.left.message);
			void this.logError('Load settings', result.left)();
			this.settings = DEFAULT_SETTINGS;
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// ── Firebase vault list ───────────────────────────────────────────────────────

export interface FirebaseVault {
	title: string;
	ref?: string;
}

async function fetchFirebaseVaults(): Promise<FirebaseVault[]> {
	const stateResult = requireFirebaseState();
	if (E.isLeft(stateResult)) return [];

	const vaultList = await withTimeout(listAll(stateResult.right.userVaultRef), 10_000, 'Fetching vault list');
	const ALL_FIREBASE_VAULTS: FirebaseVault[] = [];

	for (let i = 0; i < vaultList.prefixes.length; i++) {
		const vaultName = vaultList.prefixes[i].fullPath.split('/').pop();
		if (vaultName) {
			ALL_FIREBASE_VAULTS[i] = { title: vaultName, ref: stateResult.right.userVaultRef.fullPath };
		}
	}
	return ALL_FIREBASE_VAULTS;
}

// ── First-sync modal ──────────────────────────────────────────────────────────

export class FirstSyncModal extends Modal {
	plugin: FlintPlugin;

	constructor(app: App, plugin: FlintPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: 'Welcome to Flint' });
		contentEl.createEl('p', { text: 'This looks like the first time Flint is running on this device. How would you like to start?' });

		const makeButton = (label: string, desc: string, action: () => TE.TaskEither<FlintError, SyncSummary>) => {
			const wrap = contentEl.createDiv({ cls: 'flint-first-sync-option' });
			wrap.createEl('strong', { text: label });
			wrap.createEl('p', { text: desc, cls: 'setting-item-description' });
			wrap.addEventListener('click', () => { void (async () => {
				// Disable all options to prevent double-tap
				contentEl.querySelectorAll<HTMLElement>('.flint-first-sync-option').forEach(el => {
					el.addClass('flint-first-sync-option--disabled');
				});
				this.close();
				const result = await action()();
				if (E.isLeft(result)) {
					new Notice(`Sync failed: ${displayError(result.left)}`);
					void this.plugin.logError('First sync', result.left)();
				} else {
					this.plugin.settings.firstSyncDone = true;
					await this.plugin.saveSettings();
				}
			})(); });
		};

		makeButton(
			'Merge local and remote',
			'Upload new local files and download new remote files. Nothing is deleted. Best choice when both sides have unique content.',
			() => this.plugin.dataTools.safeFirstSync(this.plugin.app.vault, this.plugin.settings),
		);

		makeButton(
			'Take remote (replace local)',
			'Delete all local notes and replace them with the remote vault. Use this when setting up a new device.',
			() => this.plugin.dataTools.forcePull(this.plugin.app.vault, this.plugin.settings),
		);

		makeButton(
			'Take local (replace remote)',
			'Upload all local notes and overwrite the remote vault. Use this when the remote state is outdated.',
			() => this.plugin.dataTools.forcePush(this.plugin.app.vault, this.plugin.settings),
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ── Cloud vault select modal ──────────────────────────────────────────────────

export class CloudVaultSelectModal extends SuggestModal<FirebaseVault> {
	HTMLStatusbar: HTMLElement;
	pluginSettings: FlintPluginSettings;
	plugin: FlintPlugin;

	constructor(app: App, HTMLbar: HTMLElement, plugin: FlintPlugin, settings: FlintPluginSettings) {
		super(app);
		this.app = app;
		this.HTMLStatusbar = HTMLbar;
		this.pluginSettings = settings;
		this.plugin = plugin;
	}

	async getSuggestions(query: string): Promise<FirebaseVault[]> {
		const RETRIEVED_FIREBASE_VAULTS = await fetchFirebaseVaults();
		if (RETRIEVED_FIREBASE_VAULTS.length <= 0) {
			new Notice('No vaults present');
		}
		return RETRIEVED_FIREBASE_VAULTS.filter((vault) =>
			vault.title.toLowerCase().includes(query.toLowerCase())
		);
	}

	renderSuggestion(vault: FirebaseVault, el: HTMLElement) {
		el.createEl('div', { text: vault.title });
		el.createEl('small', { text: vault.ref });
	}

	onChooseSuggestion(vault: FirebaseVault, _evt: MouseEvent | KeyboardEvent): void {
		new Notice(`Selected ${vault.title}`);
		remoteVaultName = vault.title;
		void this.plugin.setRemoteDestination(vault.title);
	}
}
