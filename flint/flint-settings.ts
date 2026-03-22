import { App, PluginSettingTab, Setting } from 'obsidian';
import FlintPlugin from 'main';
import { vaultRef, auth, setupFirebase, FirebaseConfig } from 'firebase-tools';
import { ListResult, listAll } from 'firebase/storage';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from 'firebase/auth';

export interface FileSyncState {
	flintId: string;
	localHash: string;    // sha256 of file content at last successful sync
	remoteAmHash: string; // sha256 of remote .am bytes at last successful sync
}

export type SyncState = Record<string, FileSyncState>;

export interface FlintPluginSettings {
	remoteConnectedVault: string;
	userEmail: string;
	firebaseApiKey: string;
	firebaseAuthDomain: string;
	firebaseStorageBucket: string;
	firebaseProjectId: string;
	firebaseMessagingSenderId: string;
	firebaseAppId: string;
	deviceId: string;
	syncOnStartup: boolean;
	syncOnFileChange: boolean;
	scheduledSyncEnabled: boolean;
	scheduledSyncIntervalMinutes: number;
}

export const DEFAULT_SETTINGS: FlintPluginSettings = {
	remoteConnectedVault: 'default',
	userEmail: '',
	firebaseApiKey: '',
	firebaseAuthDomain: '',
	firebaseStorageBucket: '',
	firebaseProjectId: '',
	firebaseMessagingSenderId: '',
	firebaseAppId: '',
	deviceId: '',
	syncOnStartup: true,
	syncOnFileChange: true,
	scheduledSyncEnabled: false,
	scheduledSyncIntervalMinutes: 5,
}

type TabId = 'general' | 'vaults' | 'sync';

// ── Shared helpers ─────────────────────────────────────────────────────────

async function fetchVaultNames(): Promise<string[]> {
	if (!vaultRef) return [];
	const vaultList: ListResult = await listAll(vaultRef);
	return vaultList.prefixes
		.map(r => `${r}`.split('/').pop())
		.filter((n): n is string => !!n);
}

function buildFirebaseConfig(s: FlintPluginSettings): FirebaseConfig {
	return {
		apiKey: s.firebaseApiKey,
		authDomain: s.firebaseAuthDomain,
		storageBucket: s.firebaseStorageBucket,
		projectId: s.firebaseProjectId,
		messagingSenderId: s.firebaseMessagingSenderId,
		appId: s.firebaseAppId,
	};
}

function isFirebaseConfigured(s: FlintPluginSettings): boolean {
	return !!(s.firebaseApiKey && s.firebaseAuthDomain && s.firebaseStorageBucket && s.firebaseProjectId);
}

// ── Settings tab ───────────────────────────────────────────────────────────

export class FlintSettingsTab extends PluginSettingTab {
	plugin: FlintPlugin;
	private activeTab: TabId = 'general';

	constructor(app: App, plugin: FlintPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// Fetch all async data upfront, then clear+render synchronously to avoid
	// race conditions when display() is called multiple times in quick succession.
	async display(): Promise<void> {
		const isConfigured = isFirebaseConfigured(this.plugin.settings);
		const isSignedIn = !!this.plugin.settings.userEmail;
		const vaultNames = (isConfigured && isSignedIn) ? await fetchVaultNames() : [];

		const { containerEl } = this;
		containerEl.empty();

		this.renderTabBar(containerEl);

		if (this.activeTab === 'general') this.renderGeneral(containerEl, isConfigured, isSignedIn, vaultNames);
		if (this.activeTab === 'vaults') this.renderVaults(containerEl, isSignedIn, vaultNames);
		if (this.activeTab === 'sync')    this.renderSync(containerEl, isSignedIn);
	}

	// ── Tab bar ──────────────────────────────────────────────────────────────

	private renderTabBar(containerEl: HTMLElement) {
		const tabs: { id: TabId; label: string }[] = [
			{ id: 'general', label: 'General' },
			{ id: 'vaults',  label: 'Vaults'  },
			{ id: 'sync',    label: 'Sync'     },
		];

		const bar = containerEl.createDiv({ cls: 'flint-tab-bar' });
		bar.style.cssText = 'display:flex; gap:4px; margin-bottom:16px; border-bottom:1px solid var(--background-modifier-border); padding-bottom:8px;';

		for (const tab of tabs) {
			const btn = bar.createEl('button', { text: tab.label });
			btn.style.cssText = 'padding:4px 12px; border-radius:4px; border:none; cursor:pointer; background:none; color:var(--text-muted);';
			if (tab.id === this.activeTab) {
				btn.style.background = 'var(--interactive-accent)';
				btn.style.color = 'var(--text-on-accent)';
			}
			btn.onclick = () => { this.activeTab = tab.id; this.display(); };
		}
	}

	// ── General tab ──────────────────────────────────────────────────────────

	private renderGeneral(containerEl: HTMLElement, isConfigured: boolean, isSignedIn: boolean, vaultNames: string[]) {
		// Step 1: Firebase config
		if (!isConfigured) {
			containerEl.createEl('h3', { text: 'Firebase Configuration' });
			containerEl.createEl('p', {
				text: 'Enter your Firebase project credentials. Find these in Firebase Console → Project Settings → Your apps → SDK setup.',
				cls: 'setting-item-description',
			});

			const cfg = this.plugin.settings;
			const fields: { label: string; key: keyof FlintPluginSettings; placeholder: string }[] = [
				{ label: 'API Key',             key: 'firebaseApiKey',            placeholder: 'AIzaSy...' },
				{ label: 'Auth Domain',         key: 'firebaseAuthDomain',        placeholder: 'your-project.firebaseapp.com' },
				{ label: 'Storage Bucket',      key: 'firebaseStorageBucket',     placeholder: 'your-project.appspot.com' },
				{ label: 'Project ID',          key: 'firebaseProjectId',         placeholder: 'your-project' },
				{ label: 'Messaging Sender ID', key: 'firebaseMessagingSenderId', placeholder: '123456789' },
				{ label: 'App ID',              key: 'firebaseAppId',             placeholder: '1:123...' },
			];

			for (const field of fields) {
				new Setting(containerEl)
					.setName(field.label)
					.addText(text => text
						.setPlaceholder(field.placeholder)
						.setValue(cfg[field.key] as string)
						.onChange(val => { (this.plugin.settings[field.key] as string) = val.trim(); }));
			}

			new Setting(containerEl)
				.addButton(btn => btn
					.setButtonText('Save Configuration')
					.setCta()
					.onClick(async () => {
						await this.plugin.saveSettings();
						if (isFirebaseConfigured(this.plugin.settings)) {
							setupFirebase(buildFirebaseConfig(this.plugin.settings));
						}
						this.display();
					}));
			return;
		}

		// Step 2: Sign in
		if (!isSignedIn) {
			new Setting(containerEl)
				.setName('Firebase Configuration')
				.setDesc(`Project: ${this.plugin.settings.firebaseProjectId}`)
				.addButton(btn => btn
					.setButtonText('Change')
					.onClick(async () => {
						this.plugin.settings.firebaseApiKey = '';
						await this.plugin.saveSettings();
						this.display();
					}));

			containerEl.createEl('h3', { text: 'Firebase Account' });

			let emailInput = '';
			let passwordInput = '';

			new Setting(containerEl)
				.setName('Email')
				.addText(text => text
					.setPlaceholder('you@example.com')
					.onChange(val => { emailInput = val.trim(); }));

			new Setting(containerEl)
				.setName('Password')
				.addText(text => {
					text.setPlaceholder('••••••••').onChange(val => { passwordInput = val; });
					text.inputEl.type = 'password';
				});

			const errorEl = containerEl.createEl('p', { cls: 'setting-item-description mod-warning' });

			new Setting(containerEl)
				.addButton(btn => btn
					.setButtonText('Sign in')
					.setCta()
					.onClick(async () => {
						if (!auth) return;
						errorEl.setText('');
						try {
							const result = await signInWithEmailAndPassword(auth, emailInput, passwordInput);
							this.plugin.settings.userEmail = result.user.email ?? '';
							await this.plugin.saveSettings();
							this.display();
						} catch (e: any) {
							errorEl.setText(e.message ?? 'Sign-in failed');
						}
					}))
				.addButton(btn => btn
					.setButtonText('Create account')
					.onClick(async () => {
						if (!auth) return;
						errorEl.setText('');
						try {
							const result = await createUserWithEmailAndPassword(auth, emailInput, passwordInput);
							this.plugin.settings.userEmail = result.user.email ?? '';
							await this.plugin.saveSettings();
							this.display();
						} catch (e: any) {
							errorEl.setText(e.message ?? 'Account creation failed');
						}
					}));
			return;
		}

		// Step 3: Signed in
		new Setting(containerEl)
			.setName('Account')
			.setDesc(this.plugin.settings.userEmail)
			.addButton(btn => btn
				.setButtonText('Sign out')
				.onClick(async () => {
					if (auth) await signOut(auth);
					this.plugin.settings.userEmail = '';
					await this.plugin.saveSettings();
					this.display();
				}));

		const noVaultSelected = this.plugin.settings.remoteConnectedVault === 'default'
			|| !vaultNames.includes(this.plugin.settings.remoteConnectedVault);

		if (noVaultSelected) {
			new Setting(containerEl)
				.setName('Vault not initialized')
				.setDesc('Go to the Vaults tab to initialize your vault on Firebase.')
				.addButton(btn => btn
					.setButtonText('Go to Vaults')
					.setCta()
					.onClick(() => { this.activeTab = 'vaults'; this.display(); }));
			return;
		}

		new Setting(containerEl)
			.setName('Device ID')
			.setDesc(this.plugin.settings.deviceId || '(not yet assigned)')
			.setTooltip('Stable identifier for this device, used by the CRDT sync engine');
	}

	// ── Vaults tab ───────────────────────────────────────────────────────────

	private renderVaults(containerEl: HTMLElement, isSignedIn: boolean, vaultNames: string[]) {
		if (!isSignedIn) {
			containerEl.createEl('p', { text: 'Sign in first via the General tab.', cls: 'setting-item-description' });
			return;
		}

		new Setting(containerEl)
			.setName('Active vault')
			.setDesc('Vault to sync with')
			.addDropdown(drop => {
				for (const name of vaultNames) drop.addOption(name, name);
				drop.setValue(this.plugin.settings.remoteConnectedVault);
				drop.onChange(async (name) => { await this.plugin.setRemoteDestination(name); });
			});

		containerEl.createEl('h3', { text: 'Remote vaults' });

		if (vaultNames.length === 0) {
			containerEl.createEl('p', { text: 'No remote vaults yet. Create one below.', cls: 'setting-item-description' });
		}

		for (const vaultName of vaultNames) {
			new Setting(containerEl)
				.setName(vaultName)
				.addButton(btn => btn
					.setButtonText('Delete')
					.setWarning()
					.onClick(async () => {
						await this.plugin.dataTools.deleteVault(vaultName);
						if (this.plugin.settings.remoteConnectedVault === vaultName) {
							await this.plugin.setRemoteDestination('default');
						}
						this.display();
					}));
		}

		containerEl.createEl('h3', { text: 'New vault' });

		let newVaultName = '';
		new Setting(containerEl)
			.setName('Name')
			.addText(text => text
				.setPlaceholder('vault-name')
				.onChange(val => { newVaultName = val.trim(); }))
			.addButton(btn => btn
				.setButtonText('Create')
				.setCta()
				.onClick(async () => {
					if (!newVaultName) return;
					await this.plugin.setRemoteDestination(newVaultName);
					this.display();
				}));
	}

	// ── Sync tab ─────────────────────────────────────────────────────────────

	private renderSync(containerEl: HTMLElement, isSignedIn: boolean) {
		if (!isSignedIn) {
			containerEl.createEl('p', { text: 'Sign in first via the General tab.', cls: 'setting-item-description' });
			return;
		}

		new Setting(containerEl)
			.setName('Scheduled sync')
			.setDesc('Automatically sync at a fixed interval')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.scheduledSyncEnabled)
				.onChange(async (val) => {
					this.plugin.settings.scheduledSyncEnabled = val;
					await this.plugin.saveSettings();
					this.plugin.setupScheduledSync();
					this.display();
				}));

		if (this.plugin.settings.scheduledSyncEnabled) {
			new Setting(containerEl)
				.setName('Sync interval')
				.setDesc('Minutes between automatic syncs')
				.addText(text => text
					.setValue(String(this.plugin.settings.scheduledSyncIntervalMinutes))
					.onChange(async (val) => {
						const n = parseInt(val);
						if (!isNaN(n) && n > 0) {
							this.plugin.settings.scheduledSyncIntervalMinutes = n;
							await this.plugin.saveSettings();
							this.plugin.setupScheduledSync();
						}
					}));
		}
	}
}
