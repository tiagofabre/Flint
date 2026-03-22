import { Notice, TFile, TFolder, Vault } from 'obsidian';
import {
	StorageReference,
	getDownloadURL,
	ref,
	uploadBytesResumable,
	ListResult,
	listAll,
	deleteObject,
} from 'firebase/storage';
import FlintPlugin from 'main';
import { storage, vaultRef } from 'firebase-tools';
import { FlintPluginSettings, FileSyncState, SyncState } from 'flint-settings';
import {
	createDoc,
	loadDoc,
	saveDoc,
	updateDoc,
	mergeDocs,
	injectFlintId,
	extractFlintId,
} from 'crdt';

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

export class FlintDataTransfer {
	plugin: FlintPlugin;

	constructor(plugin: FlintPlugin) {
		this.plugin = plugin;
	}

	// ── Firebase helpers ──────────────────────────────────────────────────────

	private sRef(path: string): StorageReference {
		return ref(vaultRef!, path);
	}

	private async fetchBytes(r: StorageReference): Promise<Uint8Array> {
		const url = await getDownloadURL(r);
		const buf = await new Promise<ArrayBuffer>((resolve, reject) => {
			const xhr = new XMLHttpRequest();
			xhr.responseType = 'arraybuffer';
			xhr.onload = () => resolve(xhr.response);
			xhr.onerror = () => reject(new Error('XHR error'));
			xhr.open('GET', url);
			xhr.send();
		});
		return new Uint8Array(buf);
	}

	private async fetchText(r: StorageReference): Promise<string> {
		return new TextDecoder().decode(await this.fetchBytes(r));
	}

	private async uploadText(r: StorageReference, text: string): Promise<void> {
		await uploadBytesResumable(r, new TextEncoder().encode(text));
	}

	private async uploadBytes(r: StorageReference, bytes: Uint8Array): Promise<void> {
		await uploadBytesResumable(r, bytes);
	}

	private async collectPaths(list: ListResult, acc: string[] = []): Promise<string[]> {
		for (const item of list.items) acc.push(item.fullPath);
		for (const prefix of list.prefixes) {
			await this.collectPaths(await listAll(prefix), acc);
		}
		return acc;
	}

	// ── Utilities ─────────────────────────────────────────────────────────────

	private async sha256(text: string): Promise<string> {
		const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
		return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
	}

	private async sha256Bytes(bytes: Uint8Array): Promise<string> {
		const buf = await crypto.subtle.digest('SHA-256', bytes);
		return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
	}

	// ── Local .am storage (.obsidian/plugins/flint/am/<relPath>.am) ───────────

	private amLocalPath(relPath: string): string {
		return `${this.plugin.manifest.dir}/am/${relPath}.am`;
	}

	private async readLocalAm(relPath: string): Promise<Uint8Array | null> {
		try {
			const buf = await this.plugin.app.vault.adapter.readBinary(this.amLocalPath(relPath));
			return new Uint8Array(buf);
		} catch {
			return null;
		}
	}

	private async writeLocalAm(relPath: string, bytes: Uint8Array): Promise<void> {
		const path = this.amLocalPath(relPath);
		const dir = path.substring(0, path.lastIndexOf('/'));
		const adapter = this.plugin.app.vault.adapter;
		if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
		await adapter.writeBinary(path, bytes.buffer as ArrayBuffer);
	}

	// ── Sync state persistence ────────────────────────────────────────────────

	private async loadSyncState(): Promise<SyncState> {
		const data = (await this.plugin.loadData()) ?? {};
		return data.syncState ?? {};
	}

	private async saveSyncState(state: SyncState): Promise<void> {
		const data = (await this.plugin.loadData()) ?? {};
		await this.plugin.saveData({ ...data, syncState: state });
	}

	// ── Main sync entry point ─────────────────────────────────────────────────

	async syncAll(vault: Vault, settings: FlintPluginSettings): Promise<void> {
		if (!settings.remoteConnectedVault) {
			new Notice('Please select a remote vault first');
			return;
		}
		if (!vaultRef) {
			new Notice('Firebase not initialised');
			return;
		}

		new Notice('Syncing…');

		const base = settings.remoteConnectedVault;
		const prefix = this.sRef(base).fullPath + '/';

		// 1. One listAll → all remote paths (no per-file metadata calls)
		const allRemotePaths = await this.collectPaths(await listAll(this.sRef(base)));

		const remoteAmSet = new Set(allRemotePaths.filter(p => p.endsWith('.md.am')));
		const remoteMdSet = new Set(
			allRemotePaths
				.filter(p => p.endsWith('.md') && !p.endsWith('.md.am'))
				.map(p => p.startsWith(prefix) ? p.slice(prefix.length) : p)
		);

		// 2. Download remote manifest — no extra request, checked against listAll
		const manifestFullPath = `${prefix}flint-manifest.json`;
		let remoteManifest: RemoteManifest = {};
		if (allRemotePaths.includes(manifestFullPath)) {
			try {
				remoteManifest = JSON.parse(
					await this.fetchText(this.sRef(`${base}/flint-manifest.json`))
				);
			} catch { /* corrupted manifest — start fresh */ }
		}

		// 3. Load local sync state
		const syncState = await this.loadSyncState();
		const updatedSyncState: SyncState = { ...syncState };
		const updatedManifest: RemoteManifest = { ...remoteManifest };

		// 4. Process every file in the union of local and remote
		const localFiles = vault.getMarkdownFiles();
		const localMap = new Map(localFiles.map(f => [f.path, f]));
		const universe = new Set([...localMap.keys(), ...remoteMdSet]);

		let synced = 0, skipped = 0, errors = 0;

		for (const relPath of universe) {
			const localFile = localMap.get(relPath);
			const isLocal = !!localFile;
			const isRemote = remoteMdSet.has(relPath);
			const hasRemoteAm = remoteAmSet.has(`${prefix}${relPath}.am`);

			const ctx: SyncCtx = {
				base, vault, hasRemoteAm,
				state: syncState[relPath],
				updatedManifest,
				updatedSyncState,
			};

			try {
				const result = await this.processFile(relPath, localFile, isLocal, isRemote, ctx);
				result === 'skipped' ? skipped++ : synced++;
			} catch (err) {
				console.error(`[Flint] ${relPath}:`, err);
				errors++;
			}
		}

		// 5. Upload updated manifest (one write, reflects all changes this session)
		try {
			await this.uploadText(
				this.sRef(`${base}/flint-manifest.json`),
				JSON.stringify(updatedManifest)
			);
		} catch (err) {
			console.error('[Flint] manifest upload failed:', err);
		}

		// 6. Persist sync state to disk
		await this.saveSyncState(updatedSyncState);

		new Notice(
			errors > 0
				? `Sync done — ${synced} synced, ${skipped} skipped, ${errors} errors`
				: `Sync done — ${synced} synced, ${skipped} unchanged`
		);
	}

	// ── Per-file dispatcher ───────────────────────────────────────────────────

	private async processFile(
		relPath: string,
		localFile: TFile | undefined,
		isLocal: boolean,
		isRemote: boolean,
		ctx: SyncCtx,
	): Promise<'synced' | 'skipped'> {

		if (isLocal && !isRemote) {
			await this.syncNewLocal(relPath, localFile!, ctx);
			return 'synced';
		}

		if (!isLocal && isRemote) {
			if (ctx.state) {
				// Previously synced — local deletion is intentional, remove from remote
				await this.syncDeletedLocal(relPath, ctx);
			} else {
				// Never synced locally — new remote file, download it
				await this.syncNewRemote(relPath, ctx);
			}
			return 'synced';
		}

		// File exists on both sides — check what changed
		const content = await ctx.vault.read(localFile!);
		const localHash = await this.sha256(content);
		const localChanged = !ctx.state || localHash !== ctx.state.localHash;

		// Remote change detected via manifest hash comparison — zero extra network calls
		const manifestRemoteHash = ctx.updatedManifest[relPath];
		const remoteChanged = !ctx.state || manifestRemoteHash !== ctx.state.remoteAmHash;

		if (!localChanged && !remoteChanged) return 'skipped';

		if (localChanged && !remoteChanged) {
			await this.syncLocalChanged(relPath, localFile!, content, localHash, ctx);
		} else if (!localChanged && remoteChanged) {
			await this.syncRemoteChanged(relPath, localFile!, ctx);
		} else {
			await this.syncBothChanged(relPath, localFile!, content, ctx);
		}

		return 'synced';
	}

	// ── Sync handlers ─────────────────────────────────────────────────────────

	/** New file — exists locally only */
	private async syncNewLocal(relPath: string, file: TFile, ctx: SyncCtx): Promise<void> {
		let content = await ctx.vault.read(file);
		let flintId = extractFlintId(content);
		if (!flintId) {
			flintId = crypto.randomUUID();
			content = injectFlintId(content, flintId);
			await ctx.vault.modify(file, content);
		}

		const doc = createDoc(content);
		const amBytes = saveDoc(doc);

		await Promise.all([
			this.uploadText(this.sRef(`${ctx.base}/${relPath}`), content),
			this.uploadBytes(this.sRef(`${ctx.base}/${relPath}.am`), amBytes),
			this.writeLocalAm(relPath, amBytes),
		]);

		const localHash = await this.sha256(content);
		const remoteAmHash = await this.sha256Bytes(amBytes);
		ctx.updatedSyncState[relPath] = { flintId, localHash, remoteAmHash };
		ctx.updatedManifest[relPath] = remoteAmHash;
	}

	/** New file — exists remotely only */
	private async syncNewRemote(relPath: string, ctx: SyncCtx): Promise<void> {
		const mdRef = this.sRef(`${ctx.base}/${relPath}`);
		const amRef = this.sRef(`${ctx.base}/${relPath}.am`);

		const remoteContent = await this.fetchText(mdRef);
		let remoteAmBytes: Uint8Array;

		if (ctx.hasRemoteAm) {
			remoteAmBytes = await this.fetchBytes(amRef);
		} else {
			// Old-format file uploaded without .am — bootstrap it now
			const doc = createDoc(remoteContent);
			remoteAmBytes = saveDoc(doc);
			await this.uploadBytes(amRef, remoteAmBytes);
		}

		const parts = relPath.split('/');
		if (parts.length > 1) {
			await this.ensureFolder(ctx.vault, parts.slice(0, -1).join('/'));
		}
		await ctx.vault.create(relPath, remoteContent);
		await this.writeLocalAm(relPath, remoteAmBytes);

		const flintId = extractFlintId(remoteContent) ?? crypto.randomUUID();
		const localHash = await this.sha256(remoteContent);
		const remoteAmHash = await this.sha256Bytes(remoteAmBytes);
		ctx.updatedSyncState[relPath] = { flintId, localHash, remoteAmHash };
		ctx.updatedManifest[relPath] = remoteAmHash;
	}

	/** File deleted locally — remove from remote */
	private async syncDeletedLocal(relPath: string, ctx: SyncCtx): Promise<void> {
		await Promise.all([
			deleteObject(this.sRef(`${ctx.base}/${relPath}`)).catch(() => {}),
			deleteObject(this.sRef(`${ctx.base}/${relPath}.am`)).catch(() => {}),
		]);
		delete ctx.updatedManifest[relPath];
		delete ctx.updatedSyncState[relPath];
	}

	/** File changed locally, remote is unchanged */
	private async syncLocalChanged(
		relPath: string,
		file: TFile,
		content: string,
		localHash: string,
		ctx: SyncCtx,
	): Promise<void> {
		const existingAmBytes = await this.readLocalAm(relPath);
		let doc = existingAmBytes ? loadDoc(existingAmBytes) : createDoc(content);
		doc = updateDoc(doc, content);
		const amBytes = saveDoc(doc);

		let flintId = extractFlintId(content) ?? ctx.state?.flintId;
		if (!flintId) {
			flintId = crypto.randomUUID();
			await ctx.vault.modify(file, injectFlintId(content, flintId));
		}

		await Promise.all([
			this.uploadText(this.sRef(`${ctx.base}/${relPath}`), content),
			this.uploadBytes(this.sRef(`${ctx.base}/${relPath}.am`), amBytes),
			this.writeLocalAm(relPath, amBytes),
		]);

		const remoteAmHash = await this.sha256Bytes(amBytes);
		ctx.updatedSyncState[relPath] = { flintId: flintId!, localHash, remoteAmHash };
		ctx.updatedManifest[relPath] = remoteAmHash;
	}

	/** File changed remotely, local is unchanged */
	private async syncRemoteChanged(
		relPath: string,
		file: TFile,
		ctx: SyncCtx,
	): Promise<void> {
		const remoteAmBytes = await this.fetchBytes(this.sRef(`${ctx.base}/${relPath}.am`));
		const remoteDoc = loadDoc(remoteAmBytes);
		const remoteContent = remoteDoc.text;

		await ctx.vault.modify(file, remoteContent);
		await this.writeLocalAm(relPath, remoteAmBytes);

		const flintId = extractFlintId(remoteContent) ?? ctx.state?.flintId ?? crypto.randomUUID();
		const localHash = await this.sha256(remoteContent);
		const remoteAmHash = await this.sha256Bytes(remoteAmBytes);
		ctx.updatedSyncState[relPath] = { flintId, localHash, remoteAmHash };
		ctx.updatedManifest[relPath] = remoteAmHash;
	}

	/** File changed on both sides — CRDT merge */
	private async syncBothChanged(
		relPath: string,
		file: TFile,
		content: string,
		ctx: SyncCtx,
	): Promise<void> {
		const [remoteAmBytes, existingAmBytes] = await Promise.all([
			this.fetchBytes(this.sRef(`${ctx.base}/${relPath}.am`)),
			this.readLocalAm(relPath),
		]);

		const remoteDoc = loadDoc(remoteAmBytes);
		let localDoc = existingAmBytes ? loadDoc(existingAmBytes) : createDoc(content);
		localDoc = updateDoc(localDoc, content);

		const { doc: merged, text: mergedText } = mergeDocs(localDoc, remoteDoc);
		const newAmBytes = saveDoc(merged);

		if (mergedText !== content) {
			await ctx.vault.modify(file, mergedText);
		}

		await Promise.all([
			this.uploadText(this.sRef(`${ctx.base}/${relPath}`), mergedText),
			this.uploadBytes(this.sRef(`${ctx.base}/${relPath}.am`), newAmBytes),
			this.writeLocalAm(relPath, newAmBytes),
		]);

		const flintId = extractFlintId(mergedText) ?? ctx.state?.flintId ?? crypto.randomUUID();
		const newLocalHash = await this.sha256(mergedText);
		const remoteAmHash = await this.sha256Bytes(newAmBytes);
		ctx.updatedSyncState[relPath] = { flintId, localHash: newLocalHash, remoteAmHash };
		ctx.updatedManifest[relPath] = remoteAmHash;
	}

	// ── Emergency helpers ─────────────────────────────────────────────────────

	async clearRemoteVault(settings: FlintPluginSettings): Promise<void> {
		if (!settings.remoteConnectedVault || !vaultRef) return;
		const list = await listAll(this.sRef(settings.remoteConnectedVault));
		await this.deleteList(list);
	}

	private async deleteList(list: ListResult): Promise<void> {
		for (const item of list.items) {
			await deleteObject(ref(storage!, item.fullPath));
		}
		for (const prefix of list.prefixes) {
			await this.deleteList(await listAll(prefix));
		}
	}

	async forcePush(vault: Vault, settings: FlintPluginSettings): Promise<void> {
		await this.clearRemoteVault(settings);
		await this.saveSyncState({});
		await this.syncAll(vault, settings);
	}

	// ── Folder utility ────────────────────────────────────────────────────────

	private async ensureFolder(vault: Vault, folderPath: string): Promise<void> {
		const parts = folderPath.split('/');
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!(vault.getAbstractFileByPath(current) instanceof TFolder)) {
				try { await vault.createFolder(current); } catch { /* already exists */ }
			}
		}
	}
}
