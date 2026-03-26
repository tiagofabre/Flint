/**
 * Tests for the confirmMassDeletion modal fix.
 *
 * Before the fix: closing the modal with X caused the promise to hang
 * indefinitely because `onClose` was never set.
 *
 * After the fix: `modal.onClose` resolves as Left<UserCancelledError>.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as E from 'fp-ts/Either';

// ── Mocks ──────────────────────────────────────────────────────────────────────

let onCloseCallback: (() => void) | undefined;
let capturedButtons: { text: string; handler: () => void }[] = [];

vi.mock('obsidian', () => {
	class MockModal {
		titleEl = { setText: vi.fn() };
		contentEl = {
			createEl: vi.fn().mockReturnValue({
				addEventListener: vi.fn((event: string, handler: () => void) => {
					capturedButtons.push({ text: 'mock-btn', handler });
				}),
				classList: { add: vi.fn() },
				createDiv: vi.fn().mockReturnThis(),
			}),
			createDiv: vi.fn().mockImplementation(() => ({
				createEl: vi.fn().mockImplementation((tag: string, opts: { text?: string }) => {
					const el = {
						text: opts?.text ?? '',
						classList: { add: vi.fn() },
						addEventListener: vi.fn((event: string, handler: () => void) => {
							capturedButtons.push({ text: opts?.text ?? '', handler });
						}),
					};
					return el;
				}),
			})),
		};
		set onClose(fn: () => void) { onCloseCallback = fn; }
		open = vi.fn();
		close = vi.fn(() => { onCloseCallback?.(); });
	}

	return {
		Modal: MockModal,
		Notice: vi.fn(),
		Plugin: class Plugin { app: any; manifest: any; },
		TFile: class TFile {},
		TFolder: class TFolder {},
	};
});

vi.mock('firebase-tools', () => ({
	requireFirebaseState: vi.fn().mockReturnValue(E.right({ userVaultRef: { fullPath: 'vaults' } })),
	withTimeout: vi.fn(),
	withTimeoutTE: vi.fn(),
}));

vi.mock('firebase/storage', () => ({
	ref: vi.fn(),
	getDownloadURL: vi.fn(),
	uploadBytesResumable: vi.fn(),
	listAll: vi.fn(),
	deleteObject: vi.fn(),
}));

vi.mock('main', () => ({ default: class FlintPlugin {} }));

vi.mock('crdt', () => ({
	createDoc: vi.fn(),
	loadDoc: vi.fn(),
	saveDoc: vi.fn().mockReturnValue(new Uint8Array()),
	updateDoc: vi.fn(),
	mergeDocs: vi.fn(),
	injectFlintId: vi.fn(),
	extractFlintId: vi.fn().mockReturnValue(null),
}));

vi.mock('errors', async () => {
	const actual = await vi.importActual<typeof import('../errors')>('../errors');
	return actual;
});

import { FlintDataTransfer } from '../datatools';
import type { FlintError } from '../errors';

function makePlugin() {
	return {
		manifest: { dir: '.obsidian/plugins/flint' },
		app: { vault: { adapter: {} } },
		loadData: vi.fn().mockResolvedValue({}),
		saveData: vi.fn().mockResolvedValue(undefined),
		logError: vi.fn().mockReturnValue(async () => undefined),
	};
}

describe('confirmMassDeletion', () => {
	let dt: FlintDataTransfer;

	beforeEach(() => {
		onCloseCallback = undefined;
		capturedButtons = [];
		dt = new FlintDataTransfer(makePlugin() as any);
	});

	type ModalResult = E.Either<FlintError, 'proceed' | 'keep'>;

	it('resolves Left(UserCancelledError) when modal.onClose fires', async () => {
		const promise = (dt as any).confirmMassDeletion(3, 5)() as Promise<ModalResult>;

		expect(onCloseCallback).toBeDefined();
		onCloseCallback?.();

		const result = await promise;
		expect(E.isLeft(result)).toBe(true);
		if (E.isLeft(result)) {
			expect(result.left._tag).toBe('UserCancelledError');
		}
	});

	it('resolves Left(UserCancelledError) when Cancel button clicked', async () => {
		const promise = (dt as any).confirmMassDeletion(3, 5)() as Promise<ModalResult>;

		const cancelBtn = capturedButtons.find(b => b.text === 'Cancel sync');
		expect(cancelBtn).toBeDefined();
		cancelBtn?.handler();

		const result = await promise;
		expect(E.isLeft(result)).toBe(true);
		if (E.isLeft(result)) {
			expect(result.left._tag).toBe('UserCancelledError');
		}
	});

	it('resolves Right("keep") when keep button clicked', async () => {
		const promise = (dt as any).confirmMassDeletion(3, 5)() as Promise<ModalResult>;

		const keepBtn = capturedButtons.find(b => b.text === 'Keep remote files (download them)');
		expect(keepBtn).toBeDefined();
		keepBtn?.handler();

		const result = await promise;
		expect(E.isRight(result)).toBe(true);
		if (E.isRight(result)) {
			expect(result.right).toBe('keep');
		}
	});

	it('resolves Right("proceed") when delete button clicked', async () => {
		const promise = (dt as any).confirmMassDeletion(3, 5)() as Promise<ModalResult>;

		const proceedBtn = capturedButtons.find(b => b.text === 'Delete them anyway');
		expect(proceedBtn).toBeDefined();
		proceedBtn?.handler();

		const result = await promise;
		expect(E.isRight(result)).toBe(true);
		if (E.isRight(result)) {
			expect(result.right).toBe('proceed');
		}
	});

	it('does not double-resolve when button closes modal (triggering onClose)', async () => {
		const promise = (dt as any).confirmMassDeletion(3, 5)() as Promise<ModalResult>;

		// Clicking keep triggers modal.close() which fires onClose synchronously —
		// resolveOnce prevents the second call from overwriting with Left(cancelled).
		const keepBtn = capturedButtons.find(b => b.text === 'Keep remote files (download them)');
		keepBtn?.handler();

		const result = await promise;
		expect(E.isRight(result)).toBe(true); // still Right('keep'), not Left(cancelled)
		if (E.isRight(result)) {
			expect(result.right).toBe('keep');
		}
	});
});
