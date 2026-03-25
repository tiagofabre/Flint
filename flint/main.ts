import { App, Modal, Notice, Plugin, SuggestModal, TAbstractFile, TFile, debounce } from 'obsidian';
import { ListResult, listAll } from 'firebase/storage';
import { onAuthStateChanged } from 'firebase/auth';
import { FlintDataTransfer } from 'datatools';
import { vaultRef, auth, setupFirebase, setUserVaultRef, withTimeout } from 'firebase-tools';
import { FlintPluginSettings, FlintSettingsTab, DEFAULT_SETTINGS } from 'flint-settings';
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
		void this.runSync();
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

	async runSync(): Promise<void> {
		if (this.isSyncing) return;
		this.isSyncing = true;
		this.setSyncing(true);
		try {
			await this.dataTools.syncAll(this.app.vault, this.settings);
		} catch (err) {
			new Notice(`Sync failed: ${err instanceof Error ? err.message : String(err)}`);
			void this.logError('Sync', err);
		} finally {
			this.releaseSyncLock();
		}
	}

	async logError(context: string, err: unknown): Promise<void> {
		const ts = new Date().toLocaleString();
		const msg = err instanceof Error ? err.message : String(err);
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
		}
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
				void this.runSync();
			}, ms);
		}
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
			void this.runSync();
		});
		this.syncRibbon.addClass('flint-sync-ribbon-class');

		this.statusBar = this.addStatusBarItem();
		if (this.settings.remoteConnectedVault !== 'default') {
			this.statusBar.setText(`Flint remote set to ${this.settings.remoteConnectedVault}`);
		} else {
			this.statusBar.setText('Flint remote not set');
		}

		if (this.settings.firebaseApiKey) {
			setupFirebase({
				apiKey: this.settings.firebaseApiKey,
				authDomain: this.settings.firebaseAuthDomain,
				storageBucket: this.settings.firebaseStorageBucket,
				projectId: this.settings.firebaseProjectId,
				messagingSenderId: this.settings.firebaseMessagingSenderId,
				appId: this.settings.firebaseAppId,
			});
			this.unsubscribeAuth = onAuthStateChanged(auth!, (user) => {
				void (async () => {
					if (user) {
						// Firebase can fire this callback multiple times for the same
						// sign-in (token resolution, refresh, etc). Only trigger a
						// startup sync and reschedule when the user actually changes.
						const isNewLogin = user.uid !== this.lastSyncUserId;
						this.lastSyncUserId = user.uid;
						this.settings.userEmail = user.email ?? '';
						setUserVaultRef(user.uid);
						if (isNewLogin) {
							if (!this.settings.firstSyncDone) {
								new FirstSyncModal(this.app, this).open();
							} else if (this.settings.syncOnStartup) {
								void this.runSync();
							}
							this.setupScheduledSync();
						}
					} else {
						this.lastSyncUserId = null;
						this.settings.userEmail = '';
						this.setupScheduledSync(); // clears the interval on sign-out
					}
					await this.saveSettings();
				})();
			});
		}

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
					void (async () => {
						if (this.isSyncing) {
							new Notice('A sync is already in progress. Please wait.');
							return;
						}
						this.isSyncing = true;
						this.setSyncing(true);
						new Notice('Force push: clearing remote and re-uploading everything…');
						try {
							await this.dataTools.forcePush(this.app.vault, this.settings);
							new Notice('Force push complete');
						} catch (err) {
							new Notice(`Force push failed: ${err instanceof Error ? err.message : String(err)}`);
							void this.logError('Force push', err);
						} finally {
							this.releaseSyncLock();
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
					void (async () => {
						if (this.isSyncing) {
							new Notice('A sync is already in progress. Please wait.');
							return;
						}
						this.isSyncing = true;
						this.setSyncing(true);
						new Notice('Force pull: deleting local files and downloading from remote…');
						try {
							await this.dataTools.forcePull(this.app.vault, this.settings);
							new Notice('Force pull complete');
						} catch (err) {
							new Notice(`Force pull failed: ${err instanceof Error ? err.message : String(err)}`);
							void this.logError('Force pull', err);
						} finally {
							this.releaseSyncLock();
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
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()) as FlintPluginSettings;
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

export interface FirebaseVault {
	title: string;
	ref?: string;
}

async function fetchFirebaseVaults(): Promise<FirebaseVault[]> {
	if (!vaultRef) return [];

	const vaultList: ListResult = await withTimeout(listAll(vaultRef), 10_000, 'Fetching vault list');
	const ALL_FIREBASE_VAULTS: FirebaseVault[] = [];

	for (let i = 0; i < vaultList.prefixes.length; i++) {
		const vaultName = vaultList.prefixes[i].fullPath.split('/').pop();
		if (vaultName) {
			ALL_FIREBASE_VAULTS[i] = { title: vaultName, ref: vaultRef.fullPath };
		}
	}
	return ALL_FIREBASE_VAULTS;
}

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

		const makeButton = (label: string, desc: string, action: () => Promise<void>) => {
			const wrap = contentEl.createDiv({ cls: 'flint-first-sync-option' });
			wrap.createEl('strong', { text: label });
			wrap.createEl('p', { text: desc, cls: 'setting-item-description' });
			wrap.addEventListener('click', () => { void (async () => {
				// Disable all options to prevent double-tap
				contentEl.querySelectorAll<HTMLElement>('.flint-first-sync-option').forEach(el => {
					el.style.pointerEvents = 'none';
					el.style.opacity = '0.5';
				});
				this.close();
				try {
					await action();
					this.plugin.settings.firstSyncDone = true;
					await this.plugin.saveSettings();
				} catch (err) {
					new Notice(`Sync failed: ${err instanceof Error ? err.message : String(err)}`);
					void this.plugin.logError('First sync', err);
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
