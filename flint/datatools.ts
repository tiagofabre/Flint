import { Modal, Notice, TFile, TFolder, Vault, requestUrl } from 'obsidian';
import {
	StorageReference,
	ref,
	ListResult,
	listAll,
	deleteObject,
} from 'firebase/storage';
import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import * as TO from 'fp-ts/TaskOption';
import { pipe } from 'fp-ts/function';
import FlintPlugin from 'main';
import { requireFirebaseState, withTimeout } from 'firebase-tools';
import { FlintPluginSettings, FileSyncState, SyncState } from 'flint-settings';
import { FlintError, mkStorage, mkLocalFile, mkSettings, cancelled, displayError } from 'errors';
import {
	createDoc,
	loadDoc,
	saveDoc,
	updateDoc,
	mergeDocs,
	getDocText,
	injectFlintId,
	extractFlintId,
} from 'crdt';

// ── Public types ──────────────────────────────────────────────────────────────

// Maps relPath → sha256 of its .am bytes; stored in Firebase as flint-manifest.json
export type RemoteManifest = Record<string, string>;

export interface SyncCtx {
	base: string;
	vault: Vault;
	hasRemoteAm: boolean;
	state: FileSyncState | undefined;
	updatedManifest: RemoteManifest;
	updatedSyncState: SyncState;
}

export interface SyncSummary {
	synced: number;
	skipped: number;
	errors: Array<[string, FlintError]>;
}

// ── FlintDataTransfer ─────────────────────────────────────────────────────────

export class FlintDataTransfer {
	plugin: FlintPlugin;

	constructor(plugin: FlintPlugin) {
		this.plugin = plugin;
	}

	// ── Firebase helpers ──────────────────────────────────────────────────────

	private sRef(path: string): E.Either<FlintError, StorageReference> {
		return pipe(
			requireFirebaseState(),
			E.map(state => ref(state.userVaultRef, path))
		);
	}

	private fetchBytes(r: StorageReference): TE.TaskEither<FlintError, Uint8Array> {
		return async () => {
			const stateResult = requireFirebaseState();
			if (E.isLeft(stateResult)) return stateResult;
			const token = await stateResult.right.auth.currentUser?.getIdToken().catch(() => null) ?? null;
			const url = `https://firebasestorage.googleapis.com/v0/b/${r.bucket}/o/${encodeURIComponent(r.fullPath)}?alt=media`;
			try {
				const res = await requestUrl({
					url,
					method: 'GET',
					headers: token ? { 'Authorization': `Bearer ${token}` } : {},
				});
				return E.right(new Uint8Array(res.arrayBuffer));
			} catch (e) {
				return E.left(mkStorage('download', r.fullPath, e));
			}
		};
	}

	private fetchText(r: StorageReference): TE.TaskEither<FlintError, string> {
		return pipe(this.fetchBytes(r), TE.map(b => new TextDecoder().decode(b)));
	}

	private uploadBytes(r: StorageReference, bytes: Uint8Array): TE.TaskEither<FlintError, void> {
		return async () => {
			const stateResult = requireFirebaseState();
			if (E.isLeft(stateResult)) return stateResult;
			const token = await stateResult.right.auth.currentUser?.getIdToken().catch(() => null) ?? null;
			if (!token) return E.left(mkStorage('upload', r.fullPath, new Error('Not authenticated')));
			const url = `https://firebasestorage.googleapis.com/v0/b/${r.bucket}/o?uploadType=media&name=${encodeURIComponent(r.fullPath)}`;
			try {
				await requestUrl({
					url,
					method: 'POST',
					headers: {
						'Authorization': `Bearer ${token}`,
						'Content-Type': 'application/octet-stream',
					},
					body: bytes.slice().buffer,
				});
				return E.right(undefined);
			} catch (e) {
				return E.left(mkStorage('upload', r.fullPath, e));
			}
		};
	}

	private uploadText(r: StorageReference, text: string): TE.TaskEither<FlintError, void> {
		return this.uploadBytes(r, new TextEncoder().encode(text));
	}

	private fetchBytesAtPath(path: string): TE.TaskEither<FlintError, Uint8Array> {
		return pipe(TE.fromEither(this.sRef(path)), TE.chain(r => this.fetchBytes(r)));
	}

	private fetchTextAtPath(path: string): TE.TaskEither<FlintError, string> {
		return pipe(TE.fromEither(this.sRef(path)), TE.chain(r => this.fetchText(r)));
	}

	private uploadBytesAtPath(path: string, bytes: Uint8Array): TE.TaskEither<FlintError, void> {
		return pipe(TE.fromEither(this.sRef(path)), TE.chain(r => this.uploadBytes(r, bytes)));
	}

	private uploadTextAtPath(path: string, text: string): TE.TaskEither<FlintError, void> {
		return pipe(TE.fromEither(this.sRef(path)), TE.chain(r => this.uploadText(r, text)));
	}

	private collectPaths(list: ListResult, acc: string[] = []): TE.TaskEither<FlintError, string[]> {
		return async () => {
			for (const item of list.items) acc.push(item.fullPath);
			for (const prefix of list.prefixes) {
				const subResult = await TE.tryCatch(
					() => withTimeout(listAll(prefix), 10_000, 'Listing remote files'),
					e => mkStorage('list', prefix.fullPath, e),
				)();
				if (E.isLeft(subResult)) return subResult;
				const deepResult = await this.collectPaths(subResult.right, acc)();
				if (E.isLeft(deepResult)) return deepResult;
			}
			return E.right(acc);
		};
	}

	private deleteStorageObj(path: string): TE.TaskEither<FlintError, void> {
		return pipe(
			TE.fromEither(this.sRef(path)),
			TE.chain(r => TE.tryCatch(
				() => withTimeout(deleteObject(r), 10_000, `Deleting ${path}`),
				e => mkStorage('delete', path, e),
			)),
			TE.orElse(e =>
				// 404 is acceptable — file may already be gone
				e._tag === 'StorageError' && e.message.includes('object-not-found')
					? TE.right(undefined)
					: TE.left(e)
			),
		);
	}

	// ── Utilities ─────────────────────────────────────────────────────────────

	private async sha256(text: string): Promise<string> {
		const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
		return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
	}

	private async sha256Bytes(bytes: Uint8Array): Promise<string> {
		const buf = await crypto.subtle.digest('SHA-256', bytes.slice());
		return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
	}

	// ── Path validation ───────────────────────────────────────────────────────

	private isSafeRelPath(relPath: string): boolean {
		if (!relPath || relPath.startsWith('/')) return false;
		return !relPath.split('/').some(part => part === '..' || part === '.');
	}

	// ── Local .am storage (.obsidian/plugins/flint/am/<relPath>.am) ───────────

	private amLocalPath(relPath: string): string {
		return `${this.plugin.manifest.dir}/am/${relPath}.am`;
	}

	private readLocalAm(relPath: string): TO.TaskOption<Uint8Array> {
		return TO.tryCatch(() =>
			this.plugin.app.vault.adapter.readBinary(this.amLocalPath(relPath)).then(b => new Uint8Array(b))
		);
	}

	private writeLocalAm(relPath: string, bytes: Uint8Array): TE.TaskEither<FlintError, void> {
		if (!this.isSafeRelPath(relPath)) {
			return TE.left(mkLocalFile('write', relPath, new Error(`Unsafe path rejected for local .am write: ${relPath}`)));
		}
		return async () => {
			const path = this.amLocalPath(relPath);
			const dir = path.substring(0, path.lastIndexOf('/'));
			const adapter = this.plugin.app.vault.adapter;
			try {
				if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
				await adapter.writeBinary(path, bytes.slice().buffer);
				return E.right(undefined);
			} catch (e) {
				return E.left(mkLocalFile('write', relPath, e));
			}
		};
	}

	// ── Sync state persistence ────────────────────────────────────────────────

	private async loadSyncState(): Promise<SyncState> {
		const data = (await this.plugin.loadData() as Record<string, unknown>) ?? {};
		return (data.syncState ?? {}) as SyncState;
	}

	private async saveSyncState(state: SyncState): Promise<void> {
		const data = (await this.plugin.loadData() as Record<string, unknown>) ?? {};
		await this.plugin.saveData({ ...data, syncState: state });
	}

	// ── Mass-deletion guard ───────────────────────────────────────────────────

	private confirmMassDeletion(count: number, total: number): TE.TaskEither<FlintError, 'proceed' | 'keep'> {
		return () => new Promise(resolve => {
			let resolved = false;
			const resolveOnce = (val: E.Either<FlintError, 'proceed' | 'keep'>) => {
				if (!resolved) { resolved = true; resolve(val); }
			};

			const modal = new Modal(this.plugin.app);
			modal.titleEl.setText('Flint: large remote deletion detected');
			modal.contentEl.createEl('p', {
				text: `This sync would delete ${count} of ${total} remote file${count === 1 ? '' : 's'} — ` +
				      `because they are missing locally but were previously synced from this device.`,
			});
			modal.contentEl.createEl('p', {
				text: 'This can happen when setting up a new device without importing the remote vault on first sync.',
				cls: 'setting-item-description',
			});

			const btnRow = modal.contentEl.createDiv({ cls: 'flint-modal-btn-row' });

			const mkBtn = (label: string, result: 'proceed' | 'keep', cta = false) => {
				const el = btnRow.createEl('button', { text: label });
				if (cta) el.classList.add('mod-cta');
				// Resolve BEFORE closing — modal.close() fires onClose synchronously,
				// and onClose also calls resolveOnce. Resolving first ensures the
				// correct value wins; the subsequent onClose call is a no-op.
				el.addEventListener('click', () => { resolveOnce(E.right(result)); modal.close(); });
			};

			mkBtn('Keep remote files (download them)', 'keep', true);
			mkBtn('Delete them anyway', 'proceed');
			btnRow.createEl('button', { text: 'Cancel sync' })
				.addEventListener('click', () => { resolveOnce(E.left(cancelled)); modal.close(); });

			// THE FIX: closing with X also resolves (previously the promise would hang indefinitely)
			modal.onClose = () => resolveOnce(E.left(cancelled));

			modal.open();
		});
	}

	// ── Main sync entry point ─────────────────────────────────────────────────

	syncAll(vault: Vault, settings: FlintPluginSettings): TE.TaskEither<FlintError, SyncSummary> {
		if (!settings.remoteConnectedVault) {
			return TE.left(mkSettings(undefined, 'Please select a remote vault first'));
		}

		return async () => {
			// 1. Verify Firebase state
			const fbStateResult = requireFirebaseState();
			if (E.isLeft(fbStateResult)) return fbStateResult;

			const base = settings.remoteConnectedVault;
			const baseRefResult = this.sRef(base);
			if (E.isLeft(baseRefResult)) return baseRefResult;

			// 2. List all remote files (one listAll call, no per-file metadata)
			const listResult = await TE.tryCatch(
				() => withTimeout(listAll(baseRefResult.right), 10_000, 'Listing remote vault'),
				e => mkStorage('list', base, e),
			)();
			if (E.isLeft(listResult)) return listResult;

			const collectResult = await this.collectPaths(listResult.right)();
			if (E.isLeft(collectResult)) return collectResult;
			const allRemotePaths = collectResult.right;

			// 3. Build sets
			const prefix = baseRefResult.right.fullPath + '/';
			const remoteAmSet = new Set(allRemotePaths.filter(p => p.endsWith('.md.am')));
			const remoteMdSet = new Set(
				allRemotePaths
					.filter(p => p.endsWith('.md') && !p.endsWith('.md.am'))
					.map(p => p.startsWith(prefix) ? p.slice(prefix.length) : p)
			);

			// 4. Download remote manifest
			const manifestFullPath = `${prefix}flint-manifest.json`;
			let remoteManifest: RemoteManifest = {};
			if (allRemotePaths.includes(manifestFullPath)) {
				const manifestResult = await this.fetchTextAtPath(`${base}/flint-manifest.json`)();
				if (E.isRight(manifestResult)) {
					try { remoteManifest = JSON.parse(manifestResult.right) as RemoteManifest; }
					catch (e) {
						await this.plugin.logError('Manifest parse (corrupted — starting fresh)', e)();
					}
				}
			}

			// 5. Load local sync state
			const syncState = await this.loadSyncState();
			const updatedSyncState: SyncState = { ...syncState };
			const updatedManifest: RemoteManifest = { ...remoteManifest };

			// 6. Build universe of all paths to consider
			const localFiles = vault.getMarkdownFiles();
			const localMap = new Map(localFiles.map(f => [f.path, f]));
			const universe = new Set([...localMap.keys(), ...remoteMdSet]);

			// 7. Pre-scan: detect dangerous remote deletions before touching anything
			const plannedDeletions = [...remoteMdSet].filter(
				p => !localMap.has(p) && !!syncState[p]
			);
			const isDangerous =
				plannedDeletions.length > 0 &&
				(plannedDeletions.length === remoteMdSet.size ||
				 plannedDeletions.length > 5 ||
				 plannedDeletions.length / remoteMdSet.size >= 0.5);

			if (isDangerous) {
				const answerResult = await this.confirmMassDeletion(plannedDeletions.length, remoteMdSet.size)();
				if (E.isLeft(answerResult)) return answerResult; // UserCancelledError
				if (answerResult.right === 'keep') {
					// Treat those files as never-synced so they get downloaded instead of deleted
					for (const p of plannedDeletions) delete syncState[p];
				}
			}

			// 8. Process every file (accumulating — partial errors do not abort)
			const summary: SyncSummary = { synced: 0, skipped: 0, errors: [] };

			for (const relPath of universe) {
				const localFile = localMap.get(relPath);
				const isRemote = remoteMdSet.has(relPath);
				const hasRemoteAm = remoteAmSet.has(`${prefix}${relPath}.am`);

				const ctx: SyncCtx = {
					base, vault, hasRemoteAm,
					state: syncState[relPath],
					updatedManifest,
					updatedSyncState,
				};

				const result = await this.processFile(relPath, localFile, isRemote, ctx)();
				if (E.isRight(result)) {
					if (result.right === 'skipped') summary.skipped++; else summary.synced++;
				} else {
					summary.errors.push([relPath, result.left]);
					await this.plugin.logError(`Syncing ${relPath}`, result.left)();
				}
			}

			// 9. Upload updated manifest (one write per sync)
			const manifestUpload = await this.uploadTextAtPath(
				`${base}/flint-manifest.json`,
				JSON.stringify(updatedManifest)
			)();
			if (E.isLeft(manifestUpload)) {
				new Notice(`Flint: manifest upload failed — ${displayError(manifestUpload.left)}`);
				await this.plugin.logError('Manifest upload', manifestUpload.left)();
			}

			// 10. Persist sync state
			await this.saveSyncState(updatedSyncState);

			return E.right(summary);
		};
	}

	// ── Per-file dispatcher ───────────────────────────────────────────────────

	private processFile(
		relPath: string,
		localFile: TFile | undefined,
		isRemote: boolean,
		ctx: SyncCtx,
	): TE.TaskEither<FlintError, 'synced' | 'skipped'> {
		if (localFile && !isRemote) {
			return pipe(this.syncNewLocal(relPath, localFile, ctx), TE.map(() => 'synced' as const));
		}

		if (!localFile && isRemote) {
			if (ctx.state) {
				return pipe(this.syncDeletedLocal(relPath, ctx), TE.map(() => 'synced' as const));
			}
			return pipe(this.syncNewRemote(relPath, ctx), TE.map(() => 'synced' as const));
		}

		if (!localFile) return TE.right('skipped');

		return async () => {
			const contentResult = await TE.tryCatch(
				() => ctx.vault.read(localFile),
				e => mkLocalFile('read', relPath, e),
			)();
			if (E.isLeft(contentResult)) return contentResult;
			const content = contentResult.right;

			const localHash = await this.sha256(content);
			const localChanged = !ctx.state || localHash !== ctx.state.localHash;
			const manifestRemoteHash = ctx.updatedManifest[relPath];
			const remoteChanged = !ctx.state || manifestRemoteHash !== ctx.state.remoteAmHash;

			if (!localChanged && !remoteChanged) return E.right('skipped' as const);

			let handlerResult: E.Either<FlintError, 'synced'>;
			if (localChanged && !remoteChanged) {
				handlerResult = await this.syncLocalChanged(relPath, localFile, content, localHash, ctx)();
			} else if (!localChanged) {
				handlerResult = await this.syncRemoteChanged(relPath, localFile, ctx)();
			} else {
				handlerResult = await this.syncBothChanged(relPath, localFile, content, ctx)();
			}
			return handlerResult;
		};
	}

	// ── Sync handlers ─────────────────────────────────────────────────────────

	/** New file — exists locally only */
	private syncNewLocal(relPath: string, file: TFile, ctx: SyncCtx): TE.TaskEither<FlintError, 'synced'> {
		return async () => {
			const contentResult = await TE.tryCatch(() => ctx.vault.read(file), e => mkLocalFile('read', relPath, e))();
			if (E.isLeft(contentResult)) return contentResult;
			let content = contentResult.right;

			let flintId = extractFlintId(content);
			if (!flintId) {
				flintId = crypto.randomUUID();
				content = injectFlintId(content, flintId);
				const modResult = await TE.tryCatch(
					() => ctx.vault.modify(file, content),
					e => mkLocalFile('write', relPath, e)
				)();
				if (E.isLeft(modResult)) return modResult;
			}

			const doc = createDoc(content);
			const amBytes = saveDoc(doc);

			const [r1, r2, r3] = await Promise.all([
				this.uploadTextAtPath(`${ctx.base}/${relPath}`, content)(),
				this.uploadBytesAtPath(`${ctx.base}/${relPath}.am`, amBytes)(),
				this.writeLocalAm(relPath, amBytes)(),
			]);
			for (const r of [r1, r2, r3]) { if (E.isLeft(r)) return r; }

			const localHash = await this.sha256(content);
			const remoteAmHash = await this.sha256Bytes(amBytes);
			ctx.updatedSyncState[relPath] = { flintId, localHash, remoteAmHash };
			ctx.updatedManifest[relPath] = remoteAmHash;
			return E.right('synced');
		};
	}

	/** New file — exists remotely only */
	private syncNewRemote(relPath: string, ctx: SyncCtx): TE.TaskEither<FlintError, 'synced'> {
		if (!this.isSafeRelPath(relPath)) {
			return TE.left(mkLocalFile('create', relPath, new Error(`Unsafe remote path rejected: ${relPath}`)));
		}

		return async () => {
			const contentResult = await this.fetchTextAtPath(`${ctx.base}/${relPath}`)();
			if (E.isLeft(contentResult)) return contentResult;
			const remoteContent = contentResult.right;

			let remoteAmBytes: Uint8Array;
			if (ctx.hasRemoteAm) {
				const amResult = await this.fetchBytesAtPath(`${ctx.base}/${relPath}.am`)();
				if (E.isLeft(amResult)) return amResult;
				remoteAmBytes = amResult.right;
			} else {
				// Old-format file uploaded without .am — bootstrap it now
				const doc = createDoc(remoteContent);
				remoteAmBytes = saveDoc(doc);
				const uploadResult = await this.uploadBytesAtPath(`${ctx.base}/${relPath}.am`, remoteAmBytes)();
				if (E.isLeft(uploadResult)) return uploadResult;
			}

			const parts = relPath.split('/');
			if (parts.length > 1) {
				await this.ensureFolder(ctx.vault, parts.slice(0, -1).join('/'));
			}

			const createResult = await TE.tryCatch(
				() => ctx.vault.create(relPath, remoteContent),
				e => mkLocalFile('create', relPath, e),
			)();
			if (E.isLeft(createResult)) return createResult;

			const writeResult = await this.writeLocalAm(relPath, remoteAmBytes)();
			if (E.isLeft(writeResult)) return writeResult;

			const flintId = extractFlintId(remoteContent) ?? crypto.randomUUID();
			const localHash = await this.sha256(remoteContent);
			const remoteAmHash = await this.sha256Bytes(remoteAmBytes);
			ctx.updatedSyncState[relPath] = { flintId, localHash, remoteAmHash };
			ctx.updatedManifest[relPath] = remoteAmHash;
			return E.right('synced');
		};
	}

	/** File deleted locally — remove from remote */
	private syncDeletedLocal(relPath: string, ctx: SyncCtx): TE.TaskEither<FlintError, 'synced'> {
		return pipe(
			TE.Do,
			TE.chain(() => async () => {
				const [r1, r2] = await Promise.all([
					this.deleteStorageObj(`${ctx.base}/${relPath}`)(),
					this.deleteStorageObj(`${ctx.base}/${relPath}.am`)(),
				]);
				if (E.isLeft(r1)) return r1;
				if (E.isLeft(r2)) return r2;
				delete ctx.updatedManifest[relPath];
				delete ctx.updatedSyncState[relPath];
				return E.right('synced' as const);
			}),
		);
	}

	/** File changed locally, remote is unchanged */
	private syncLocalChanged(
		relPath: string,
		file: TFile,
		content: string,
		localHash: string,
		ctx: SyncCtx,
	): TE.TaskEither<FlintError, 'synced'> {
		return async () => {
			const existingAmOption = await this.readLocalAm(relPath)();

			let doc;
			if (O.isSome(existingAmOption)) {
				try { doc = loadDoc(existingAmOption.value); }
				catch (e) {
					await this.plugin.logError(`CRDT load failed for ${relPath} (falling back to fresh doc)`, e)();
					doc = createDoc(content);
				}
			} else {
				doc = createDoc(content);
			}
			doc = updateDoc(doc, content);
			const amBytes = saveDoc(doc);

			let flintId = extractFlintId(content) ?? ctx.state?.flintId;
			if (!flintId) {
				flintId = crypto.randomUUID();
				const modResult = await TE.tryCatch(
					() => ctx.vault.modify(file, injectFlintId(content, flintId as string)),
					e => mkLocalFile('write', relPath, e),
				)();
				if (E.isLeft(modResult)) return modResult;
			}

			const [r1, r2, r3] = await Promise.all([
				this.uploadTextAtPath(`${ctx.base}/${relPath}`, content)(),
				this.uploadBytesAtPath(`${ctx.base}/${relPath}.am`, amBytes)(),
				this.writeLocalAm(relPath, amBytes)(),
			]);
			for (const r of [r1, r2, r3]) { if (E.isLeft(r)) return r; }

			const remoteAmHash = await this.sha256Bytes(amBytes);
			ctx.updatedSyncState[relPath] = { flintId, localHash, remoteAmHash };
			ctx.updatedManifest[relPath] = remoteAmHash;
			return E.right('synced');
		};
	}

	/** File changed remotely, local is unchanged */
	private syncRemoteChanged(
		relPath: string,
		file: TFile,
		ctx: SyncCtx,
	): TE.TaskEither<FlintError, 'synced'> {
		return async () => {
			let remoteAmBytes: Uint8Array;
			const amResult = await this.fetchBytesAtPath(`${ctx.base}/${relPath}.am`)();
			if (E.isRight(amResult)) {
				remoteAmBytes = amResult.right;
			} else {
				// .am inaccessible — fall back to .md content and bootstrap a new doc
				await this.plugin.logError(`Fetching .am for ${relPath} (falling back to .md)`, amResult.left)();
				const mdResult = await this.fetchTextAtPath(`${ctx.base}/${relPath}`)();
				if (E.isLeft(mdResult)) return mdResult;
				const doc = createDoc(mdResult.right);
				remoteAmBytes = saveDoc(doc);
				const uploadResult = await this.uploadBytesAtPath(`${ctx.base}/${relPath}.am`, remoteAmBytes)();
				if (E.isLeft(uploadResult)) return uploadResult;
			}

			const remoteDoc = loadDoc(remoteAmBytes);
			const remoteContent = getDocText(remoteDoc);

			const modResult = await TE.tryCatch(
				() => ctx.vault.modify(file, remoteContent),
				e => mkLocalFile('write', relPath, e),
			)();
			if (E.isLeft(modResult)) return modResult;

			const writeResult = await this.writeLocalAm(relPath, remoteAmBytes)();
			if (E.isLeft(writeResult)) return writeResult;

			const flintId = extractFlintId(remoteContent) ?? ctx.state?.flintId ?? crypto.randomUUID();
			const localHash = await this.sha256(remoteContent);
			const remoteAmHash = await this.sha256Bytes(remoteAmBytes);
			ctx.updatedSyncState[relPath] = { flintId, localHash, remoteAmHash };
			ctx.updatedManifest[relPath] = remoteAmHash;
			return E.right('synced');
		};
	}

	/** File changed on both sides — CRDT merge */
	private syncBothChanged(
		relPath: string,
		file: TFile,
		content: string,
		ctx: SyncCtx,
	): TE.TaskEither<FlintError, 'synced'> {
		return async () => {
			let remoteAmBytes: Uint8Array;
			const amResult = await this.fetchBytesAtPath(`${ctx.base}/${relPath}.am`)();
			if (E.isRight(amResult)) {
				remoteAmBytes = amResult.right;
			} else {
				// .am inaccessible — bootstrap from remote .md so merge still proceeds
				await this.plugin.logError(`Fetching .am for ${relPath} during merge (falling back to .md)`, amResult.left)();
				const mdResult = await this.fetchTextAtPath(`${ctx.base}/${relPath}`)();
				if (E.isLeft(mdResult)) return mdResult;
				const doc = createDoc(mdResult.right);
				remoteAmBytes = saveDoc(doc);
				const uploadResult = await this.uploadBytesAtPath(`${ctx.base}/${relPath}.am`, remoteAmBytes)();
				if (E.isLeft(uploadResult)) return uploadResult;
			}

			const existingAmOption = await this.readLocalAm(relPath)();

			const remoteDoc = loadDoc(remoteAmBytes);
			let localDoc;
			if (O.isSome(existingAmOption)) {
				try { localDoc = loadDoc(existingAmOption.value); }
				catch (e) {
					await this.plugin.logError(`CRDT load failed for ${relPath} during merge (falling back to fresh doc)`, e)();
					localDoc = createDoc(content);
				}
			} else {
				localDoc = createDoc(content);
			}
			localDoc = updateDoc(localDoc, content);

			const { doc: merged, text: mergedText } = mergeDocs(localDoc, remoteDoc);
			const newAmBytes = saveDoc(merged);

			if (mergedText !== content) {
				const modResult = await TE.tryCatch(
					() => ctx.vault.modify(file, mergedText),
					e => mkLocalFile('write', relPath, e),
				)();
				if (E.isLeft(modResult)) return modResult;
			}

			const [r1, r2, r3] = await Promise.all([
				this.uploadTextAtPath(`${ctx.base}/${relPath}`, mergedText)(),
				this.uploadBytesAtPath(`${ctx.base}/${relPath}.am`, newAmBytes)(),
				this.writeLocalAm(relPath, newAmBytes)(),
			]);
			for (const r of [r1, r2, r3]) { if (E.isLeft(r)) return r; }

			const flintId = extractFlintId(mergedText) ?? ctx.state?.flintId ?? crypto.randomUUID();
			const newLocalHash = await this.sha256(mergedText);
			const remoteAmHash = await this.sha256Bytes(newAmBytes);
			ctx.updatedSyncState[relPath] = { flintId, localHash: newLocalHash, remoteAmHash };
			ctx.updatedManifest[relPath] = remoteAmHash;
			return E.right('synced');
		};
	}

	// ── Emergency helpers ─────────────────────────────────────────────────────

	async deleteVault(vaultName: string): Promise<void> {
		const stateResult = requireFirebaseState();
		if (E.isLeft(stateResult)) throw new Error(displayError(stateResult.left));
		const list = await withTimeout(listAll(ref(stateResult.right.userVaultRef, vaultName)), 10_000, 'Listing vault for deletion');
		await this.deleteList(list);
	}

	async clearRemoteVault(settings: FlintPluginSettings): Promise<void> {
		if (!settings.remoteConnectedVault) return;
		const stateResult = requireFirebaseState();
		if (E.isLeft(stateResult)) throw new Error(displayError(stateResult.left));
		const listRef = ref(stateResult.right.userVaultRef, settings.remoteConnectedVault);
		const list = await withTimeout(listAll(listRef), 10_000, 'Listing vault for deletion');
		await this.deleteList(list);
	}

	private async deleteList(list: ListResult): Promise<void> {
		for (const item of list.items) {
			await withTimeout(deleteObject(item), 10_000, `Deleting ${item.name}`);
		}
		for (const prefix of list.prefixes) {
			await this.deleteList(await withTimeout(listAll(prefix), 10_000, 'Listing remote files'));
		}
	}

	/** Merge for first-time setup: clears syncState so no file is mistaken for an intentional deletion. */
	safeFirstSync(vault: Vault, settings: FlintPluginSettings): TE.TaskEither<FlintError, SyncSummary> {
		return pipe(
			TE.tryCatch(() => this.saveSyncState({}), e => mkLocalFile('write', 'syncState', e)),
			TE.chainW(() => this.syncAll(vault, settings)),
		);
	}

	forcePush(vault: Vault, settings: FlintPluginSettings): TE.TaskEither<FlintError, SyncSummary> {
		return pipe(
			TE.tryCatch(() => this.clearRemoteVault(settings), e => mkStorage('delete', 'vault', e)),
			TE.chainW(() => TE.tryCatch(() => this.saveSyncState({}), e => mkLocalFile('write', 'syncState', e))),
			TE.chainW(() => this.syncAll(vault, settings)),
		);
	}

	forcePull(vault: Vault, settings: FlintPluginSettings): TE.TaskEither<FlintError, SyncSummary> {
		return pipe(
			// Await ALL deletions before proceeding — fixes the previous race condition
			TE.tryCatch(
				() => Promise.all(vault.getMarkdownFiles().map(f => this.plugin.app.fileManager.trashFile(f))),
				e => mkLocalFile('delete', 'vault', e),
			),
			TE.chainW(() => TE.tryCatch(() => this.saveSyncState({}), e => mkLocalFile('write', 'syncState', e))),
			TE.chainW(() => this.syncAll(vault, settings)),
		);
	}

	// ── Folder utility ────────────────────────────────────────────────────────

	private async ensureFolder(vault: Vault, folderPath: string): Promise<void> {
		const parts = folderPath.split('/');
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!(vault.getAbstractFileByPath(current) instanceof TFolder)) {
				try {
					await vault.createFolder(current);
				} catch (e) {
					// Re-check: if the folder now exists, a concurrent create beat us — safe to continue.
					// Otherwise re-throw so the caller sees the real error.
					if (!(vault.getAbstractFileByPath(current) instanceof TFolder)) throw e;
				}
			}
		}
	}
}
