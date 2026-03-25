/**
 * Tests for the sync dispatch table:
 *
 * | localChanged | remoteChanged | Action          |
 * |--------------|---------------|-----------------|
 * | false        | false         | skip            |
 * | true         | false         | syncLocalChanged|
 * | false        | true          | syncRemoteChanged|
 * | true         | true          | syncBothChanged |
 * | local only   | —             | syncNewLocal    |
 * | remote only  | —             | syncNewRemote   |
 *
 * All handler methods are mocked so only the dispatch logic is tested here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── External dependency mocks (hoisted before imports) ────────────────────────

vi.mock('obsidian', () => ({
	TFile: class TFile {},
	TFolder: class TFolder {},
	Notice: vi.fn(),
	Plugin: class Plugin { app: any; manifest: any; },
}));

vi.mock('firebase/storage', () => ({
	ref: vi.fn(),
	getDownloadURL: vi.fn(),
	uploadBytesResumable: vi.fn(),
	listAll: vi.fn(),
	deleteObject: vi.fn(),
}));

vi.mock('firebase-tools', () => ({
	vaultRef: { fullPath: 'vaults' },
}));

vi.mock('main', () => ({
	default: class FlintPlugin {},
}));

vi.mock('crdt', () => ({
	createDoc: vi.fn(),
	loadDoc: vi.fn(),
	saveDoc: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
	updateDoc: vi.fn(),
	mergeDocs: vi.fn(),
	injectFlintId: vi.fn((c: string, id: string) => `---\n_flint_id: ${id}\n---\n${c}`),
	extractFlintId: vi.fn().mockReturnValue(null),
	initAutomerge: vi.fn().mockResolvedValue(undefined),
}));

import { FlintDataTransfer, SyncCtx } from '../datatools';
import { FileSyncState } from '../flint-settings';

// ── Helpers ───────────────────────────────────────────────────────────────────

const CONTENT = 'hello world';
const CONTENT_HASH = 'hash:hello world';
const REMOTE_AM_HASH = 'remote-am-hash-abc';

function makePlugin() {
	return {
		manifest: { dir: '.obsidian/plugins/flint' },
		app: {
			vault: {
				adapter: {
					readBinary: vi.fn().mockRejectedValue(new Error('not found')),
					writeBinary: vi.fn().mockResolvedValue(undefined),
					exists: vi.fn().mockResolvedValue(true),
					mkdir: vi.fn().mockResolvedValue(undefined),
				},
			},
		},
		loadData: vi.fn().mockResolvedValue({}),
		saveData: vi.fn().mockResolvedValue(undefined),
	};
}

function makeCtx(overrides: Partial<SyncCtx> = {}): SyncCtx {
	return {
		base: 'test-vault',
		vault: { read: vi.fn().mockResolvedValue(CONTENT) } as any,
		hasRemoteAm: true,
		state: undefined,
		updatedManifest: {},
		updatedSyncState: {},
		...overrides,
	};
}

function makeState(localHash = CONTENT_HASH, remoteAmHash = REMOTE_AM_HASH): FileSyncState {
	return { flintId: 'test-uuid', localHash, remoteAmHash };
}

function makeFakeFile(path = 'note.md') {
	return { path } as any;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('sync dispatch table', () => {
	let dt: FlintDataTransfer;

	// Spies for each handler
	let spyNewLocal: ReturnType<typeof vi.spyOn>;
	let spyNewRemote: ReturnType<typeof vi.spyOn>;
	let spyLocalChanged: ReturnType<typeof vi.spyOn>;
	let spyRemoteChanged: ReturnType<typeof vi.spyOn>;
	let spyBothChanged: ReturnType<typeof vi.spyOn>;
	let spySha256: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		dt = new FlintDataTransfer(makePlugin() as any);

		// Mock all handlers so only dispatch logic executes
		spyNewLocal     = vi.spyOn(dt as any, 'syncNewLocal').mockResolvedValue(undefined);
		spyNewRemote    = vi.spyOn(dt as any, 'syncNewRemote').mockResolvedValue(undefined);
		spyLocalChanged = vi.spyOn(dt as any, 'syncLocalChanged').mockResolvedValue(undefined);
		spyRemoteChanged = vi.spyOn(dt as any, 'syncRemoteChanged').mockResolvedValue(undefined);
		spyBothChanged  = vi.spyOn(dt as any, 'syncBothChanged').mockResolvedValue(undefined);

		// sha256 returns a deterministic string based on input so we can control hashes
		spySha256 = vi.spyOn(dt as any, 'sha256').mockImplementation(
			async (text: string) => `hash:${text}`
		);
	});

	// ── Row 1: local only ─────────────────────────────────────────────────────

	it('local only → syncNewLocal', async () => {
		const ctx = makeCtx();
		const result = await (dt as any).processFile(
			'note.md', makeFakeFile(), false, ctx
		);

		expect(result).toBe('synced');
		expect(spyNewLocal).toHaveBeenCalledOnce();
		expect(spyNewLocal).toHaveBeenCalledWith('note.md', expect.anything(), ctx);
		expect(spyNewRemote).not.toHaveBeenCalled();
		expect(spyLocalChanged).not.toHaveBeenCalled();
		expect(spyRemoteChanged).not.toHaveBeenCalled();
		expect(spyBothChanged).not.toHaveBeenCalled();
	});

	// ── Row 2: remote only ────────────────────────────────────────────────────

	it('remote only → syncNewRemote', async () => {
		const ctx = makeCtx();
		const result = await (dt as any).processFile(
			'note.md', undefined, true, ctx
		);

		expect(result).toBe('synced');
		expect(spyNewRemote).toHaveBeenCalledOnce();
		expect(spyNewRemote).toHaveBeenCalledWith('note.md', ctx);
		expect(spyNewLocal).not.toHaveBeenCalled();
		expect(spyLocalChanged).not.toHaveBeenCalled();
		expect(spyRemoteChanged).not.toHaveBeenCalled();
		expect(spyBothChanged).not.toHaveBeenCalled();
	});

	// ── Row 3: nothing changed → skip ─────────────────────────────────────────

	it('localChanged=false, remoteChanged=false → skip', async () => {
		// state.localHash matches current content hash, manifest hash matches state
		const ctx = makeCtx({
			state: makeState(CONTENT_HASH, REMOTE_AM_HASH),
			updatedManifest: { 'note.md': REMOTE_AM_HASH }, // same as state
		});

		const result = await (dt as any).processFile(
			'note.md', makeFakeFile(), true, ctx
		);

		expect(result).toBe('skipped');
		expect(spySha256).toHaveBeenCalledWith(CONTENT); // hash was computed
		expect(spyLocalChanged).not.toHaveBeenCalled();
		expect(spyRemoteChanged).not.toHaveBeenCalled();
		expect(spyBothChanged).not.toHaveBeenCalled();
		expect(spyNewLocal).not.toHaveBeenCalled();
		expect(spyNewRemote).not.toHaveBeenCalled();
	});

	// ── Row 4: local changed only → upload ────────────────────────────────────

	it('localChanged=true, remoteChanged=false → syncLocalChanged', async () => {
		// state.localHash is OLD (doesn't match current content hash)
		const ctx = makeCtx({
			state: makeState('hash:old content', REMOTE_AM_HASH),
			updatedManifest: { 'note.md': REMOTE_AM_HASH }, // remote unchanged
		});

		const result = await (dt as any).processFile(
			'note.md', makeFakeFile(), true, ctx
		);

		expect(result).toBe('synced');
		expect(spyLocalChanged).toHaveBeenCalledOnce();
		expect(spyLocalChanged).toHaveBeenCalledWith(
			'note.md', expect.anything(), CONTENT, CONTENT_HASH, ctx
		);
		expect(spyRemoteChanged).not.toHaveBeenCalled();
		expect(spyBothChanged).not.toHaveBeenCalled();
	});

	// ── Row 5: remote changed only → download ─────────────────────────────────

	it('localChanged=false, remoteChanged=true → syncRemoteChanged', async () => {
		const NEW_REMOTE_HASH = 'remote-am-hash-NEW';
		// state.localHash matches current content but manifest has a new remote hash
		const ctx = makeCtx({
			state: makeState(CONTENT_HASH, REMOTE_AM_HASH),
			updatedManifest: { 'note.md': NEW_REMOTE_HASH }, // remote changed
		});

		const result = await (dt as any).processFile(
			'note.md', makeFakeFile(), true, ctx
		);

		expect(result).toBe('synced');
		expect(spyRemoteChanged).toHaveBeenCalledOnce();
		expect(spyRemoteChanged).toHaveBeenCalledWith('note.md', expect.anything(), ctx);
		expect(spyLocalChanged).not.toHaveBeenCalled();
		expect(spyBothChanged).not.toHaveBeenCalled();
	});

	// ── Row 6: both changed → CRDT merge ──────────────────────────────────────

	it('localChanged=true, remoteChanged=true → syncBothChanged', async () => {
		const NEW_REMOTE_HASH = 'remote-am-hash-NEW';
		const ctx = makeCtx({
			state: makeState('hash:old content', REMOTE_AM_HASH), // local stale
			updatedManifest: { 'note.md': NEW_REMOTE_HASH },      // remote also changed
		});

		const result = await (dt as any).processFile(
			'note.md', makeFakeFile(), true, ctx
		);

		expect(result).toBe('synced');
		expect(spyBothChanged).toHaveBeenCalledOnce();
		expect(spyBothChanged).toHaveBeenCalledWith(
			'note.md', expect.anything(), CONTENT, ctx
		);
		expect(spyLocalChanged).not.toHaveBeenCalled();
		expect(spyRemoteChanged).not.toHaveBeenCalled();
	});

	// ── Edge: no state + both exist → treat as both changed ───────────────────

	it('no prior sync state + exists on both sides → syncBothChanged', async () => {
		// When state is undefined, both localChanged and remoteChanged are true
		const ctx = makeCtx({
			state: undefined,
			updatedManifest: { 'note.md': REMOTE_AM_HASH },
		});

		const result = await (dt as any).processFile(
			'note.md', makeFakeFile(), true, ctx
		);

		expect(result).toBe('synced');
		expect(spyBothChanged).toHaveBeenCalledOnce();
	});
});
