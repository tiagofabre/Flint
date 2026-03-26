import { App, ButtonComponent, Modal, PluginSettingTab, Setting, setIcon } from 'obsidian';
import { z } from 'zod';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import FlintPlugin from 'main';
import { requireFirebaseState, getFirebaseAuth, withTimeout } from 'firebase-tools';
import { ListResult, listAll } from 'firebase/storage';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from 'firebase/auth';
import { FlintError, mkSettings, mkStorage, displayError } from 'errors';

// ── Settings schema ───────────────────────────────────────────────────────────

export const FlintPluginSettingsSchema = z.object({
	remoteConnectedVault:         z.string().default('default'),
	userEmail:                    z.string().default(''),
	firebaseApiKey:               z.string().default(''),
	firebaseAuthDomain:           z.string().default(''),
	firebaseStorageBucket:        z.string().default(''),
	firebaseProjectId:            z.string().default(''),
	firebaseMessagingSenderId:    z.string().default(''),
	firebaseAppId:                z.string().default(''),
	deviceId:                     z.string().default(''),
	syncOnStartup:                z.boolean().default(true),
	syncOnFileChange:             z.boolean().default(true),
	scheduledSyncEnabled:         z.boolean().default(false),
	scheduledSyncIntervalMinutes: z.number().int().min(1).default(5),
	firstSyncDone:                z.boolean().default(false),
});

export type FlintPluginSettings = z.infer<typeof FlintPluginSettingsSchema>;
export const DEFAULT_SETTINGS: FlintPluginSettings = FlintPluginSettingsSchema.parse({});

export function parseSettings(raw: unknown): E.Either<SettingsError, FlintPluginSettings> {
	const result = FlintPluginSettingsSchema.partial().merge(FlintPluginSettingsSchema).safeParse(raw ?? {});
	return result.success
		? E.right(result.data)
		: E.left(mkSettings(undefined, result.error.issues.map(i => i.message).join('; ')));
}

// Re-export for backwards compat
export type SettingsError = { readonly _tag: 'SettingsError'; readonly field?: string; readonly message: string };

// ── File sync state ───────────────────────────────────────────────────────────

export interface FileSyncState {
	flintId: string;
	localHash: string;    // sha256 of file content at last successful sync
	remoteAmHash: string; // sha256 of remote .am bytes at last successful sync
}

export type SyncState = Record<string, FileSyncState>;

// ── Button loading helper ─────────────────────────────────────────────────────

function setButtonLoading(btn: ButtonComponent, loading: boolean, label: string): void {
	btn.setDisabled(loading);
	if (loading) {
		btn.buttonEl.empty();
		setIcon(btn.buttonEl, 'loader');
		btn.buttonEl.addClass('flint-btn-loading');
	} else {
		btn.buttonEl.empty();
		btn.buttonEl.removeClass('flint-btn-loading');
		btn.setButtonText(label);
	}
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function fetchVaultNames(): TE.TaskEither<FlintError, string[]> {
	return pipe(
		TE.fromEither(requireFirebaseState()),
		TE.chain(state => TE.tryCatch(
			() => withTimeout(listAll(state.userVaultRef), 10_000, 'Fetching vault list'),
			e => mkStorage('list', 'vaults', e)
		)),
		TE.map((result: ListResult) =>
			result.prefixes
				.map(r => r.fullPath.split('/').pop())
				.filter((n): n is string => !!n)
		),
	);
}

export function isFirebaseConfigured(s: FlintPluginSettings): boolean {
	return !!(s.firebaseApiKey && s.firebaseAuthDomain && s.firebaseStorageBucket && s.firebaseProjectId);
}

// ── Confirmation modal ────────────────────────────────────────────────────────

class ConfirmModal extends Modal {
	private message: string;
	private onConfirm: () => Promise<void>;
	private plugin: FlintPlugin;

	constructor(app: App, plugin: FlintPlugin, message: string, onConfirm: () => Promise<void>) {
		super(app);
		this.plugin = plugin;
		this.message = message;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		this.render();
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('p', { text: this.message });
		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText('Cancel')
				.onClick(() => this.close()))
			.addButton(btn => btn
				.setButtonText('Delete')
				.setWarning()
				.onClick(() => { void this.confirm(); }));
	}

	private async confirm() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('p', { text: 'Deleting…' });

		try {
			await this.onConfirm();
			contentEl.empty();
			contentEl.createEl('p', { text: 'Vault deleted.' });
			setTimeout(() => this.close(), 1200);
		} catch (e: unknown) {
			void this.plugin.logError('Delete vault', e)();
			contentEl.empty();
			contentEl.createEl('p', { text: `Error: ${e instanceof Error ? e.message : 'Delete failed.'}`, cls: 'mod-warning' });
			new Setting(contentEl)
				.addButton(btn => btn
					.setButtonText('Close')
					.onClick(() => this.close()));
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ── Settings tab ──────────────────────────────────────────────────────────────

type TabId = 'general' | 'vaults' | 'sync';

export class FlintSettingsTab extends PluginSettingTab {
	plugin: FlintPlugin;
	private activeTab: TabId = 'general';

	constructor(app: App, plugin: FlintPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// Fetch all async data upfront, then clear+render synchronously to avoid
	// race conditions when display() is called multiple times in quick succession.
	display(): void {
		void pipe(
			this._display(),
			TE.mapLeft(err => {
				this.containerEl.empty();
				this.containerEl.createEl('p', {
					text: `Settings error: ${displayError(err)}`,
					cls: 'mod-warning',
				});
			}),
		)();
	}

	private _display(): TE.TaskEither<FlintError, void> {
		const isConfigured = isFirebaseConfigured(this.plugin.settings);
		const isSignedIn = !!this.plugin.settings.userEmail;
		return pipe(
			(isConfigured && isSignedIn)
				? pipe(fetchVaultNames(), TE.orElse(() => TE.right([] as string[])))
				: TE.right([] as string[]),
			TE.map(vaultNames => {
				const { containerEl } = this;
				containerEl.empty();
				this.renderTabBar(containerEl);
				if (this.activeTab === 'general') this.renderGeneral(containerEl, isConfigured, isSignedIn, vaultNames);
				if (this.activeTab === 'vaults') this.renderVaults(containerEl, isSignedIn, vaultNames);
				if (this.activeTab === 'sync')   this.renderSync(containerEl, isSignedIn);
			}),
		);
	}

	// ── Tab bar ───────────────────────────────────────────────────────────────

	private renderTabBar(containerEl: HTMLElement) {
		const tabs: { id: TabId; label: string }[] = [
			{ id: 'general', label: 'General' },
			{ id: 'vaults',  label: 'Vaults'  },
			{ id: 'sync',    label: 'Sync'     },
		];

		const bar = containerEl.createDiv({ cls: 'flint-tab-bar' });

		for (const tab of tabs) {
			const btn = bar.createEl('button', { text: tab.label, cls: 'flint-tab-btn' });
			if (tab.id === this.activeTab) btn.addClass('flint-tab-btn--active');
			btn.onclick = () => { this.activeTab = tab.id; this.display(); };
		}
	}

	// ── General tab ───────────────────────────────────────────────────────────

	private renderGeneral(containerEl: HTMLElement, isConfigured: boolean, isSignedIn: boolean, vaultNames: string[]) {
		// Step 1: Firebase config
		if (!isConfigured) {
			new Setting(containerEl).setName('Firebase configuration').setHeading();
			containerEl.createEl('p', {
				// eslint-disable-next-line obsidianmd/ui/sentence-case
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
					.setButtonText('Save configuration')
					.setCta()
					.onClick(() => {
						setButtonLoading(btn, true, 'Save configuration');
						void pipe(
							TE.tryCatch(async () => {
								await this.plugin.saveSettings();
								if (isFirebaseConfigured(this.plugin.settings)) {
									this.plugin.setupFirebaseAndAuth();
								}
								this.display();
							}, e => mkSettings(undefined, String(e))),
							TE.mapLeft(err => {
								void this.plugin.logError('Save configuration', err)();
								setButtonLoading(btn, false, 'Save configuration');
							}),
						)();
					}));
			return;
		}

		// Step 2: Sign in
		if (!isSignedIn) {
			new Setting(containerEl)
				.setName('Firebase configuration')
				.setDesc(`Project: ${this.plugin.settings.firebaseProjectId}`)
				.addButton(btn => btn
					.setButtonText('Change')
					.onClick(() => {
						setButtonLoading(btn, true, 'Change');
						void pipe(
							TE.tryCatch(async () => {
								this.plugin.settings.firebaseApiKey = '';
								await this.plugin.saveSettings();
								this.display();
							}, e => mkSettings(undefined, String(e))),
							TE.mapLeft(() => setButtonLoading(btn, false, 'Change')),
						)();
					}));

			new Setting(containerEl).setName('Firebase account').setHeading();

			let emailInput = '';
			let passwordInput = '';

			new Setting(containerEl)
				.setName('Email')
				.addText(text => text
					// eslint-disable-next-line obsidianmd/ui/sentence-case
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
					.onClick(() => {
						errorEl.setText('');
						setButtonLoading(btn, true, 'Sign in');
						void pipe(
							TE.fromEither(getFirebaseAuth()),
							TE.chain(a => TE.tryCatch(
								() => withTimeout(signInWithEmailAndPassword(a, emailInput, passwordInput), 10_000, 'Sign in'),
								(e): FlintError => ({ _tag: 'FirebaseAuthError', code: (e as { code?: string })?.code ?? '', message: e instanceof Error ? e.message : String(e) }),
							)),
							TE.chain(result => TE.tryCatch(async () => {
								this.plugin.settings.userEmail = result.user.email ?? '';
								await this.plugin.saveSettings();
								this.display();
							}, e => mkSettings(undefined, String(e)))),
							TE.mapLeft(err => {
								errorEl.setText(displayError(err));
								void this.plugin.logError('Sign in', err)();
								setButtonLoading(btn, false, 'Sign in');
							}),
						)();
					}))
				.addButton(btn => btn
					.setButtonText('Create account')
					.onClick(() => {
						errorEl.setText('');
						setButtonLoading(btn, true, 'Create account');
						void pipe(
							TE.fromEither(getFirebaseAuth()),
							TE.chain(a => TE.tryCatch(
								() => withTimeout(createUserWithEmailAndPassword(a, emailInput, passwordInput), 10_000, 'Create account'),
								(e): FlintError => ({ _tag: 'FirebaseAuthError', code: (e as { code?: string })?.code ?? '', message: e instanceof Error ? e.message : String(e) }),
							)),
							TE.chain(result => TE.tryCatch(async () => {
								this.plugin.settings.userEmail = result.user.email ?? '';
								await this.plugin.saveSettings();
								this.display();
							}, e => mkSettings(undefined, String(e)))),
							TE.mapLeft(err => {
								errorEl.setText(displayError(err));
								void this.plugin.logError('Create account', err)();
								setButtonLoading(btn, false, 'Create account');
							}),
						)();
					}));
			return;
		}

		// Step 3: Signed in
		new Setting(containerEl)
			.setName('Account')
			.setDesc(this.plugin.settings.userEmail)
			.addButton(btn => btn
				.setButtonText('Sign out')
				.onClick(() => {
					setButtonLoading(btn, true, 'Sign out');
					void pipe(
						TE.fromEither(getFirebaseAuth()),
						TE.chain(a => TE.tryCatch(
							() => withTimeout(signOut(a), 10_000, 'Sign out'),
							e => mkSettings(undefined, String(e))
						)),
						TE.chain(() => TE.tryCatch(async () => {
							this.plugin.settings.userEmail = '';
							await this.plugin.saveSettings();
							this.display();
						}, e => mkSettings(undefined, String(e)))),
						TE.mapLeft(err => {
							void this.plugin.logError('Sign out', err)();
							setButtonLoading(btn, false, 'Sign out');
						}),
					)();
				}));

		const noVaultSelected = this.plugin.settings.remoteConnectedVault === 'default'
			|| !vaultNames.includes(this.plugin.settings.remoteConnectedVault);

		if (noVaultSelected) {
			new Setting(containerEl)
				.setName('Vault not initialized')
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				.setDesc('Go to the Vaults tab to initialize your vault on Firebase.')
				.addButton(btn => btn
					.setButtonText('Go to vaults')
					.setCta()
					.onClick(() => { this.activeTab = 'vaults'; this.display(); }));
			return;
		}

		new Setting(containerEl)
			.setName('Device ID')
			.setDesc(this.plugin.settings.deviceId || '(not yet assigned)')
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setTooltip('Stable identifier for this device, used by the CRDT sync engine');
	}

	// ── Vaults tab ────────────────────────────────────────────────────────────

	private renderVaults(containerEl: HTMLElement, isSignedIn: boolean, vaultNames: string[]) {
		if (!isSignedIn) {
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			containerEl.createEl('p', { text: 'Sign in first via the General tab.', cls: 'setting-item-description' });
			return;
		}

		const localVaultName = this.plugin.app.vault.getName();
		const remoteVault = this.plugin.settings.remoteConnectedVault;
		const isInitialized = vaultNames.includes(remoteVault);

		// ── Initialize prompt ─────────────────────────────────────────────────
		if (!isInitialized) {
			const targetName = remoteVault === 'default' ? localVaultName : remoteVault;
			new Setting(containerEl)
				.setName(`Initialize "${targetName}"`)
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				.setDesc('This vault has not been pushed to Firebase yet.')
				.addButton(btn => btn
					.setButtonText('Initialize')
					.setCta()
					.onClick(() => {
						setButtonLoading(btn, true, 'Initialize');
						void pipe(
							TE.tryCatch(async () => {
								await this.plugin.setRemoteDestination(targetName);
								await this.plugin.runSync()();
								this.display();
							}, e => mkSettings(undefined, String(e))),
							TE.mapLeft(err => {
								void this.plugin.logError('Initialize vault', err)();
								setButtonLoading(btn, false, 'Initialize');
							}),
						)();
					}));
			return;
		}

		// ── Active vault ──────────────────────────────────────────────────────
		new Setting(containerEl)
			.setName('Active vault')
			.setDesc('Vault to sync with')
			.addDropdown(drop => {
				for (const name of vaultNames) drop.addOption(name, name);
				drop.setValue(remoteVault);
				drop.onChange((name) => { void (async () => { await this.plugin.setRemoteDestination(name); })(); });
			});

		// ── Remote vaults list ────────────────────────────────────────────────
		new Setting(containerEl).setName('Remote vaults').setHeading();

		for (const vaultName of vaultNames) {
			new Setting(containerEl)
				.setName(vaultName)
				.addButton(btn => btn
					.setButtonText('Delete')
					.setWarning()
					.onClick(() => {
						new ConfirmModal(
							this.plugin.app,
							this.plugin,
							`Delete "${vaultName}" from Firebase? This cannot be undone.`,
							async () => {
								await this.plugin.dataTools.deleteVault(vaultName);
								if (this.plugin.settings.remoteConnectedVault === vaultName) {
									await this.plugin.setRemoteDestination('default');
								}
								this.display();
							}
						).open();
					}));
		}
	}

	// ── Sync tab ──────────────────────────────────────────────────────────────

	private renderSync(containerEl: HTMLElement, isSignedIn: boolean) {
		if (!isSignedIn) {
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			containerEl.createEl('p', { text: 'Sign in first via the General tab.', cls: 'setting-item-description' });
			return;
		}

		new Setting(containerEl)
			.setName('Force sync')
			.setDesc('Clear the remote vault and re-upload everything from this device.')
			.addButton(btn => btn
				.setButtonText('Force sync')
				.setWarning()
				.onClick(() => {
					new ConfirmModal(
						this.plugin.app,
						this.plugin,
						'This will overwrite the entire remote vault with your local files. Continue?',
						() => this.plugin.dataTools.forcePush(this.plugin.app.vault, this.plugin.settings)().then(r => {
							if (E.isLeft(r)) throw new Error(displayError(r.left));
						})
					).open();
				}));

		new Setting(containerEl)
			.setName('Sync on startup')
			.setDesc('Sync automatically when Obsidian opens or you sign in.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncOnStartup)
				.onChange((val) => { void (async () => {
					this.plugin.settings.syncOnStartup = val;
					await this.plugin.saveSettings();
				})(); }));

		new Setting(containerEl)
			.setName('Sync on file change')
			.setDesc('Sync 5 seconds after a note is created, modified, or deleted.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncOnFileChange)
				.onChange((val) => { void (async () => {
					this.plugin.settings.syncOnFileChange = val;
					await this.plugin.saveSettings();
				})(); }));

		new Setting(containerEl)
			.setName('Scheduled sync')
			.setDesc('Sync automatically at a fixed interval.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.scheduledSyncEnabled)
				.onChange((val) => { void (async () => {
					this.plugin.settings.scheduledSyncEnabled = val;
					await this.plugin.saveSettings();
					this.plugin.setupScheduledSync();
					this.display();
				})(); }));

		if (this.plugin.settings.scheduledSyncEnabled) {
			new Setting(containerEl)
				.setName('Sync interval')
				.setDesc('Minutes between scheduled syncs.')
				.addText(text => text
					.setValue(String(this.plugin.settings.scheduledSyncIntervalMinutes))
					.onChange((val) => { void (async () => {
						const n = parseInt(val);
						if (!isNaN(n) && n > 0) {
							this.plugin.settings.scheduledSyncIntervalMinutes = n;
							await this.plugin.saveSettings();
							this.plugin.setupScheduledSync();
						}
					})(); }));
		}
	}
}
