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
}

export class FlintSettingsTab extends PluginSettingTab {
	plugin: FlintPlugin;

	constructor(app: App, plugin: FlintPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	async #fetchVaultOptions() {
		if (!vaultRef) return {};
		const vaultList: ListResult = await listAll(vaultRef);

		let ALL_FIREBASE_VAULTS: Record<string, string> = {};

		for (let i = 0; i < vaultList.prefixes.length; i++) {
			const vaultName = `${vaultList.prefixes[i]}`.split('/').pop();
			if (vaultName) {
				ALL_FIREBASE_VAULTS[vaultName] = vaultName;
			}
		}
		return ALL_FIREBASE_VAULTS;
	}

	#isConfigured() {
		const s = this.plugin.settings;
		return s.firebaseApiKey && s.firebaseAuthDomain && s.firebaseStorageBucket && s.firebaseProjectId;
	}

	async display(): Promise<void> {
		const { containerEl } = this;
		containerEl.empty();

		// ── Step 1: Firebase Configuration ──────────────────────────────────
		if (!this.#isConfigured()) {
			containerEl.createEl('h3', { text: 'Firebase Configuration' });
			containerEl.createEl('p', {
				text: 'Enter your Firebase project credentials. Find these in Firebase Console → Project Settings → Your apps → SDK setup.',
				cls: 'setting-item-description',
			});

			const cfg = this.plugin.settings;
			const fields: { label: string; key: keyof FlintPluginSettings; placeholder: string }[] = [
				{ label: 'API Key',             key: 'firebaseApiKey',           placeholder: 'AIzaSy...' },
				{ label: 'Auth Domain',         key: 'firebaseAuthDomain',       placeholder: 'your-project.firebaseapp.com' },
				{ label: 'Storage Bucket',      key: 'firebaseStorageBucket',    placeholder: 'your-project.appspot.com' },
				{ label: 'Project ID',          key: 'firebaseProjectId',        placeholder: 'your-project' },
				{ label: 'Messaging Sender ID', key: 'firebaseMessagingSenderId', placeholder: '123456789' },
				{ label: 'App ID',              key: 'firebaseAppId',            placeholder: '1:123...' },
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
						if (this.#isConfigured()) {
							setupFirebase(this.#buildConfig());
						}
						this.display();
					}));
			return;
		}

		// ── Step 2: Firebase Account ─────────────────────────────────────────
		if (!this.plugin.settings.userEmail) {
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
					text.setPlaceholder('••••••••')
						.onChange(val => { passwordInput = val; });
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

		// ── Step 3: Signed in — show vault selector ───────────────────────────
		new Setting(containerEl)
			.setName('Firebase Account')
			.setDesc(this.plugin.settings.userEmail)
			.addButton(btn => btn
				.setButtonText('Sign out')
				.onClick(async () => {
					if (auth) await signOut(auth);
					this.plugin.settings.userEmail = '';
					await this.plugin.saveSettings();
					this.display();
				}));

		const allVaultOptions = await this.#fetchVaultOptions();

		new Setting(containerEl)
			.setName('Current Connected Remote Vault')
			.setDesc('Active Firebase Vault')
			.addDropdown(options => options
				.addOptions(allVaultOptions)
				.onChange(async (name: string) => {
					this.plugin.setRemoteDestination(name);
				}));

		new Setting(containerEl)
			.setName('Device ID')
			.setDesc(this.plugin.settings.deviceId || '(not yet assigned)')
			.setTooltip('Stable identifier for this device, used by the CRDT sync engine');
	}

	#buildConfig(): FirebaseConfig {
		const s = this.plugin.settings;
		return {
			apiKey: s.firebaseApiKey,
			authDomain: s.firebaseAuthDomain,
			storageBucket: s.firebaseStorageBucket,
			projectId: s.firebaseProjectId,
			messagingSenderId: s.firebaseMessagingSenderId,
			appId: s.firebaseAppId,
		};
	}
}

