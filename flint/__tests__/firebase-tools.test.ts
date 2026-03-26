import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as E from 'fp-ts/Either';

vi.mock('firebase/storage', () => ({
	getStorage: vi.fn().mockReturnValue({}),
	ref: vi.fn((storage: any, path: string) => ({ fullPath: path })),
}));

vi.mock('firebase/app', () => ({
	initializeApp: vi.fn().mockReturnValue({}),
	getApps: vi.fn().mockReturnValue([]),
}));

vi.mock('firebase/auth', () => ({
	getAuth: vi.fn().mockReturnValue({ type: 'mock-auth' }),
}));

// Import after mocks — use dynamic import to get a fresh module in each test
// (we need to reset internal _state between tests)
describe('firebase-tools', () => {
	// We reimport in each describe block to get a fresh module state.
	// Vitest doesn't easily allow resetting module-level singletons, so
	// we simply test the public contract of each function.

	beforeEach(() => {
		vi.resetModules();
	});

	it('requireFirebaseState returns Left before setupFirebase', async () => {
		const { requireFirebaseState } = await import('../firebase-tools');
		const result = requireFirebaseState();
		expect(E.isLeft(result)).toBe(true);
	});

	it('setupFirebase returns Right on success', async () => {
		const { setupFirebase } = await import('../firebase-tools');
		const result = setupFirebase({
			apiKey: 'k', authDomain: 'a', storageBucket: 'b',
			projectId: 'p', messagingSenderId: 'm', appId: 'i',
		});
		expect(E.isRight(result)).toBe(true);
	});

	it('requireFirebaseState returns Left after setupFirebase (userVaultRef not set)', async () => {
		const { setupFirebase, requireFirebaseState } = await import('../firebase-tools');
		const { displayError } = await import('../errors');
		setupFirebase({ apiKey: 'k', authDomain: 'a', storageBucket: 'b', projectId: 'p', messagingSenderId: 'm', appId: 'i' });
		const result = requireFirebaseState();
		expect(E.isLeft(result)).toBe(true);
		if (E.isLeft(result)) {
			expect(displayError(result.left)).toContain('vault ref not set');
		}
	});

	it('setUserVaultRef returns Left if Firebase not yet initialized', async () => {
		const { setUserVaultRef } = await import('../firebase-tools');
		const result = setUserVaultRef('uid123');
		expect(E.isLeft(result)).toBe(true);
	});

	it('requireFirebaseState returns Right after setup + setUserVaultRef', async () => {
		const { setupFirebase, setUserVaultRef, requireFirebaseState } = await import('../firebase-tools');
		setupFirebase({ apiKey: 'k', authDomain: 'a', storageBucket: 'b', projectId: 'p', messagingSenderId: 'm', appId: 'i' });
		const setResult = setUserVaultRef('uid123');
		expect(E.isRight(setResult)).toBe(true);
		const stateResult = requireFirebaseState();
		expect(E.isRight(stateResult)).toBe(true);
		if (E.isRight(stateResult)) {
			expect(stateResult.right.userVaultRef).toBeDefined();
		}
	});

	it('getFirebaseAuth returns Left before setup', async () => {
		const { getFirebaseAuth } = await import('../firebase-tools');
		expect(E.isLeft(getFirebaseAuth())).toBe(true);
	});

	it('getFirebaseAuth returns Right after setup', async () => {
		const { setupFirebase, getFirebaseAuth } = await import('../firebase-tools');
		setupFirebase({ apiKey: 'k', authDomain: 'a', storageBucket: 'b', projectId: 'p', messagingSenderId: 'm', appId: 'i' });
		expect(E.isRight(getFirebaseAuth())).toBe(true);
	});

	describe('withTimeoutTE', () => {
		it('resolves Right on success', async () => {
			const { withTimeoutTE } = await import('../firebase-tools');
			const result = await withTimeoutTE(Promise.resolve(42), 5000, 'test')();
			expect(result).toEqual(E.right(42));
		});

		it('resolves Left on rejection', async () => {
			const { withTimeoutTE } = await import('../firebase-tools');
			const result = await withTimeoutTE(Promise.reject(new Error('boom')), 5000, 'test')();
			expect(E.isLeft(result)).toBe(true);
		});

		it('resolves Left(TimeoutError) on timeout', async () => {
			const { withTimeoutTE } = await import('../firebase-tools');
			const slow = new Promise<never>(() => { /* never resolves */ });
			const result = await withTimeoutTE(slow, 10, 'slow op')();
			expect(E.isLeft(result)).toBe(true);
			if (E.isLeft(result)) {
				expect(result.left._tag).toBe('TimeoutError');
			}
		});
	});
});
