import { App, Editor, MarkdownView, Notice, Plugin, SuggestModal } from 'obsidian';
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
				} else {
					this.settings.userEmail = '';
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
			callback: () => {
				if (!this.settings.userEmail) {
					new Notice('Please sign in first (Flint Settings)');
					return;
				}
				new Notice('Force Push: clearing remote and re-uploading everything…');
				this.dataTools.forcePush(this.app.vault, this.settings).then(() => {
					new Notice('Force Push complete');
				}).catch((err) => {
					new Notice(`Force Push failed: ${err}`);
				});
			}
		});

		this.addSettingTab(new FlintSettingsTab(this.app, this));
	}

	async setRemoteDestination(remoteName: string) {
		remoteVaultName = remoteName;
		this.settings.remoteConnectedVault = remoteName;
		this.statusBar.setText(`Flint Remote Set to ${remoteName}`);
		new Notice(`Syncing to ${remoteName}`);
		await this.saveSettings();
	}

	onunload() {}

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
