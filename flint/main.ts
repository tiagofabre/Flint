import { App, Editor, MarkdownView, Modal, Notice, Plugin, SuggestModal, TAbstractFile, TFile, debounce } from 'obsidian';
import { ListResult, listAll } from 'firebase/storage';
import { onAuthStateChanged } from 'firebase/auth';
import { FlintDataTransfer } from 'datatools';
import { vaultRef, auth, setupFirebase, setUserVaultRef } from 'firebase-tools';
import { FlintPluginSettings, FlintSettingsTab, DEFAULT_SETTINGS } from 'flint-settings';
import { initAutomerge } from 'crdt';

export let currentVaultName: string = 'vaults';
export let remoteVaultName: string = '';

export default class FlintPlugin extends Plugin {
	settings: FlintPluginSettings;
	statusBar: HTMLElement;
	dataTools: FlintDataTransfer;

	private readonly debouncedSync = debounce(() => {
		if (!this.settings.userEmail || !this.settings.syncOnFileChange) return;
		this.dataTools.syncAll(this.app.vault, this.settings);
	}, 5000, true);

	private scheduledSyncHandle: number | null = null;

	setupScheduledSync() {
		if (this.scheduledSyncHandle !== null) {
			window.clearInterval(this.scheduledSyncHandle);
			this.scheduledSyncHandle = null;
		}
		if (this.settings.scheduledSyncEnabled && this.settings.userEmail) {
			const ms = this.settings.scheduledSyncIntervalMinutes * 60 * 1000;
			this.scheduledSyncHandle = window.setInterval(() => {
				this.dataTools.syncAll(this.app.vault, this.settings);
			}, ms);
		}
	}

	async onload() {
		await initAutomerge();
		await this.loadSettings();
		currentVaultName = await this.app.vault.getName();
		remoteVaultName = this.settings.remoteConnectedVault;
		this.dataTools = new FlintDataTransfer(this);

		// Generate a stable device ID if not yet assigned
		if (!this.settings.deviceId) {
			this.settings.deviceId = crypto.randomUUID();
			await this.saveSettings();
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
			onAuthStateChanged(auth!, async (user) => {
				if (user) {
					this.settings.userEmail = user.email ?? '';
					setUserVaultRef(user.uid);
					if (!this.settings.firstSyncDone) {
						new FirstSyncModal(this.app, this).open();
					} else if (this.settings.syncOnStartup) {
						this.dataTools.syncAll(this.app.vault, this.settings);
					}
					this.setupScheduledSync();
				} else {
					this.settings.userEmail = '';
					this.setupScheduledSync(); // clears the interval on sign-out
				}
				await this.saveSettings();
			});
		}

		const syncRibbon = this.addRibbonIcon('refresh-cw', 'Sync Vault', (evt: MouseEvent) => {
			if (!this.settings.userEmail) {
				new Notice('Please sign in first (Flint Settings)');
				return;
			}
			this.dataTools.syncAll(this.app.vault, this.settings);
		});
		syncRibbon.addClass('flint-sync-ribbon-class');

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

		this.statusBar = this.addStatusBarItem();
		if (this.settings.remoteConnectedVault !== 'default') {
			this.statusBar.setText(`Flint Remote Set to ${this.settings.remoteConnectedVault}`);
		} else {
			this.statusBar.setText('Flint Remote Not Set');
		}

		this.addCommand({
			id: 'import-cloud-vault',
			name: 'Import Vault from Cloud',
			callback: () => {
				if (!this.settings.userEmail) {
					new Notice('Please sign in first (Flint Settings)');
					return;
				}
				const selectionModal = new CloudVaultSelectModal(this.app, this.statusBar, this, this.settings);
				selectionModal.open();
			}
		});

		this.addCommand({
			id: 'force-push',
			name: 'Force Push (overwrite remote)',
			checkCallback: (checking: boolean) => {
				if (!this.settings.userEmail) return false;
				if (!checking) {
					new Notice('Force Push: clearing remote and re-uploading everything…');
					(async () => {
						try {
							await this.dataTools.forcePush(this.app.vault, this.settings);
							new Notice('Force Push complete');
						} catch (err) {
							new Notice(`Force Push failed: ${err}`);
						}
					})();
				}
				return true;
			}
		});

		this.addCommand({
			id: 'force-pull',
			name: 'Force Pull (overwrite local with remote)',
			checkCallback: (checking: boolean) => {
				if (!this.settings.userEmail) return false;
				if (!checking) {
					new Notice('Force Pull: deleting local files and downloading from remote…');
					(async () => {
						try {
							await this.dataTools.forcePull(this.app.vault, this.settings);
							new Notice('Force Pull complete');
						} catch (err) {
							new Notice(`Force Pull failed: ${err}`);
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
		this.statusBar.setText(`Flint Remote Set to ${remoteName}`);
		new Notice(`Syncing to ${remoteName}`);
		await this.saveSettings();
	}

	onunload() {
		if (this.scheduledSyncHandle !== null) {
			window.clearInterval(this.scheduledSyncHandle);
			this.scheduledSyncHandle = null;
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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

	const vaultList: ListResult = await listAll(vaultRef);
	const ALL_FIREBASE_VAULTS: FirebaseVault[] = [];

	for (let i = 0; i < vaultList.prefixes.length; i++) {
		const vaultName = `${vaultList.prefixes[i]}`.split('/').pop();
		if (vaultName) {
			ALL_FIREBASE_VAULTS[i] = { title: vaultName, ref: `${vaultRef}` };
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

		const makeButton = (label: string, desc: string, onClick: () => void) => {
			const wrap = contentEl.createDiv({ cls: 'flint-first-sync-option' });
			wrap.createEl('strong', { text: label });
			wrap.createEl('p', { text: desc, cls: 'setting-item-description' });
			wrap.addEventListener('click', onClick);
		};

		makeButton(
			'Merge local and remote',
			'Upload new local files and download new remote files. Nothing is deleted. Best choice when both sides have unique content.',
			async () => {
				this.close();
				await this.plugin.dataTools.safeFirstSync(this.plugin.app.vault, this.plugin.settings);
				this.plugin.settings.firstSyncDone = true;
				await this.plugin.saveSettings();
			}
		);

		makeButton(
			'Take remote (replace local)',
			'Delete all local notes and replace them with the remote vault. Use this when setting up a new device.',
			async () => {
				this.close();
				await this.plugin.dataTools.forcePull(this.plugin.app.vault, this.plugin.settings);
				this.plugin.settings.firstSyncDone = true;
				await this.plugin.saveSettings();
			}
		);

		makeButton(
			'Take local (replace remote)',
			'Upload all local notes and overwrite the remote vault. Use this when the remote state is outdated.',
			async () => {
				this.close();
				await this.plugin.dataTools.forcePush(this.plugin.app.vault, this.plugin.settings);
				this.plugin.settings.firstSyncDone = true;
				await this.plugin.saveSettings();
			}
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
			new Notice('NO VAULTS PRESENT');
		}
		return RETRIEVED_FIREBASE_VAULTS.filter((vault) =>
			vault.title.toLowerCase().includes(query.toLowerCase())
		);
	}

	renderSuggestion(vault: FirebaseVault, el: HTMLElement) {
		el.createEl('div', { text: vault.title });
		el.createEl('small', { text: vault.ref });
	}

	async onChooseSuggestion(vault: FirebaseVault, evt: MouseEvent | KeyboardEvent) {
		new Notice(`Selected ${vault.title}`);
		remoteVaultName = vault.title;
		this.plugin.setRemoteDestination(vault.title);
	}
}
