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
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';

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
	requireFirebaseState: vi.fn().mockReturnValue(E.right({ userVaultRef: { fullPath: 'vaults' } })),
	withTimeout: vi.fn(),
	withTimeoutTE: vi.fn(),
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

vi.mock('errors', () => ({
	mkLocalFile: vi.fn((op: string, path: string, e: unknown) => ({ _tag: 'LocalFileError', op, path, message: String(e) })),
	mkStorage: vi.fn((op: string, path: string, e: unknown) => ({ _tag: 'StorageError', op, path, message: String(e) })),
	mkNetwork: vi.fn((msg: string) => ({ _tag: 'NetworkError', message: msg })),
	mkSettings: vi.fn((field: string | undefined, msg: string) => ({ _tag: 'SettingsError', field, message: msg })),
	cancelled: { _tag: 'UserCancelledError' },
	displayError: vi.fn((e: any) => e?.message ?? String(e)),
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
		logError: vi.fn().mockReturnValue(async () => undefined),
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

	// Spies for each handler — now return TaskEither<FlintError, 'synced'>
	let spyNewLocal: ReturnType<typeof vi.spyOn>;
	let spyNewRemote: ReturnType<typeof vi.spyOn>;
	let spyLocalChanged: ReturnType<typeof vi.spyOn>;
	let spyRemoteChanged: ReturnType<typeof vi.spyOn>;
	let spyBothChanged: ReturnType<typeof vi.spyOn>;
	let spySha256: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		dt = new FlintDataTransfer(makePlugin() as any);

		// Mock all handlers to return TE.right('synced')
		spyNewLocal      = vi.spyOn(dt as any, 'syncNewLocal').mockReturnValue(TE.right('synced' as const));
		spyNewRemote     = vi.spyOn(dt as any, 'syncNewRemote').mockReturnValue(TE.right('synced' as const));
		spyLocalChanged  = vi.spyOn(dt as any, 'syncLocalChanged').mockReturnValue(TE.right('synced' as const));
		spyRemoteChanged = vi.spyOn(dt as any, 'syncRemoteChanged').mockReturnValue(TE.right('synced' as const));
		spyBothChanged   = vi.spyOn(dt as any, 'syncBothChanged').mockReturnValue(TE.right('synced' as const));

		// sha256 returns a deterministic string based on input so we can control hashes
		spySha256 = vi.spyOn(dt as any, 'sha256').mockImplementation(
			async (text: string) => `hash:${text}`
		);
	});

	// ── Row 1: local only ─────────────────────────────────────────────────────

	it('local only → syncNewLocal', async () => {
		const ctx = makeCtx();
		const result = await (dt as any).processFile('note.md', false, ctx, makeFakeFile())();

		expect(E.isRight(result)).toBe(true);
		if (E.isRight(result)) expect(result.right).toBe('synced');
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
		const result = await (dt as any).processFile('note.md', true, ctx, undefined)();

		expect(E.isRight(result)).toBe(true);
		if (E.isRight(result)) expect(result.right).toBe('synced');
		expect(spyNewRemote).toHaveBeenCalledOnce();
		expect(spyNewRemote).toHaveBeenCalledWith('note.md', ctx);
		expect(spyNewLocal).not.toHaveBeenCalled();
		expect(spyLocalChanged).not.toHaveBeenCalled();
		expect(spyRemoteChanged).not.toHaveBeenCalled();
		expect(spyBothChanged).not.toHaveBeenCalled();
	});

	// ── Row 3: nothing changed → skip ─────────────────────────────────────────

	it('localChanged=false, remoteChanged=false → skip', async () => {
		const ctx = makeCtx({
			state: makeState(CONTENT_HASH, REMOTE_AM_HASH),
			updatedManifest: { 'note.md': REMOTE_AM_HASH }, // same as state
		});

		const result = await (dt as any).processFile('note.md', true, ctx, makeFakeFile())();

		expect(E.isRight(result)).toBe(true);
		if (E.isRight(result)) expect(result.right).toBe('skipped');
		expect(spySha256).toHaveBeenCalledWith(CONTENT);
		expect(spyLocalChanged).not.toHaveBeenCalled();
		expect(spyRemoteChanged).not.toHaveBeenCalled();
		expect(spyBothChanged).not.toHaveBeenCalled();
		expect(spyNewLocal).not.toHaveBeenCalled();
		expect(spyNewRemote).not.toHaveBeenCalled();
	});

	// ── Row 4: local changed only → upload ────────────────────────────────────

	it('localChanged=true, remoteChanged=false → syncLocalChanged', async () => {
		const ctx = makeCtx({
			state: makeState('hash:old content', REMOTE_AM_HASH),
			updatedManifest: { 'note.md': REMOTE_AM_HASH }, // remote unchanged
		});

		const result = await (dt as any).processFile('note.md', true, ctx, makeFakeFile())();

		expect(E.isRight(result)).toBe(true);
		if (E.isRight(result)) expect(result.right).toBe('synced');
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
		const ctx = makeCtx({
			state: makeState(CONTENT_HASH, REMOTE_AM_HASH),
			updatedManifest: { 'note.md': NEW_REMOTE_HASH }, // remote changed
		});

		const result = await (dt as any).processFile('note.md', true, ctx, makeFakeFile())();

		expect(E.isRight(result)).toBe(true);
		if (E.isRight(result)) expect(result.right).toBe('synced');
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

		const result = await (dt as any).processFile('note.md', true, ctx, makeFakeFile())();

		expect(E.isRight(result)).toBe(true);
		if (E.isRight(result)) expect(result.right).toBe('synced');
		expect(spyBothChanged).toHaveBeenCalledOnce();
		expect(spyBothChanged).toHaveBeenCalledWith(
			'note.md', expect.anything(), CONTENT, ctx
		);
		expect(spyLocalChanged).not.toHaveBeenCalled();
		expect(spyRemoteChanged).not.toHaveBeenCalled();
	});

	// ── Edge: no state + both exist → treat as both changed ───────────────────

	it('no prior sync state + exists on both sides → syncBothChanged', async () => {
		const ctx = makeCtx({
			state: undefined,
			updatedManifest: { 'note.md': REMOTE_AM_HASH },
		});

		const result = await (dt as any).processFile('note.md', true, ctx, makeFakeFile())();

		expect(E.isRight(result)).toBe(true);
		expect(spyBothChanged).toHaveBeenCalledOnce();
	});

	// ── Error propagation: handler Left propagates ────────────────────────────

	it('handler Left propagates through processFile', async () => {
		const err = { _tag: 'StorageError' as const, op: 'upload' as const, path: 'test', message: 'fail' };
		spyNewLocal.mockReturnValue(TE.left(err));
		const ctx = makeCtx();
		const result = await (dt as any).processFile('note.md', false, ctx, makeFakeFile())();

		expect(E.isLeft(result)).toBe(true);
		if (E.isLeft(result)) expect(result.left).toEqual(err);
	});
});
