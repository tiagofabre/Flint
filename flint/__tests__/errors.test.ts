import { describe, it, expect } from 'vitest';
import {
	displayError,
	friendlyAuthCode,
	mkNetwork, mkStorage, mkLocalFile, mkCrdt, mkSettings, mkSync, mkTimeout, mkFirebaseAuth, cancelled,
	type FlintError,
} from '../errors';

describe('smart constructors', () => {
	it('mkNetwork preserves message and optional path', () => {
		expect(mkNetwork('oops')).toEqual({ _tag: 'NetworkError', message: 'oops', path: undefined });
		expect(mkNetwork('oops', '/foo')).toEqual({ _tag: 'NetworkError', message: 'oops', path: '/foo' });
	});

	it('mkStorage converts Error objects to message string', () => {
		const r = mkStorage('upload', 'some/path', new Error('write failed'));
		expect(r._tag).toBe('StorageError');
		expect(r.op).toBe('upload');
		expect(r.path).toBe('some/path');
		expect(r.message).toBe('write failed');
	});

	it('mkStorage converts non-Error values to string', () => {
		expect(mkStorage('delete', 'p', 'raw string').message).toBe('raw string');
		expect(mkStorage('delete', 'p', 42).message).toBe('42');
	});

	it('mkLocalFile captures op and path', () => {
		const r = mkLocalFile('read', 'notes/foo.md', new Error('ENOENT'));
		expect(r._tag).toBe('LocalFileError');
		expect(r.op).toBe('read');
		expect(r.path).toBe('notes/foo.md');
		expect(r.message).toBe('ENOENT');
	});

	it('mkCrdt captures phase and path', () => {
		const r = mkCrdt('merge', 'notes/bar.md', new Error('bad doc'));
		expect(r._tag).toBe('CrdtError');
		expect(r.phase).toBe('merge');
		expect(r.path).toBe('notes/bar.md');
	});

	it('mkSettings with and without field', () => {
		expect(mkSettings(undefined, 'bad value')).toEqual({ _tag: 'SettingsError', field: undefined, message: 'bad value' });
		expect(mkSettings('apiKey', 'missing')).toEqual({ _tag: 'SettingsError', field: 'apiKey', message: 'missing' });
	});

	it('mkSync wraps cause', () => {
		const cause = mkNetwork('net fail');
		const r = mkSync('notes/x.md', cause);
		expect(r._tag).toBe('SyncError');
		expect(r.path).toBe('notes/x.md');
		expect(r.cause).toBe(cause);
	});

	it('mkTimeout', () => {
		expect(mkTimeout('Listing', 5000)).toEqual({ _tag: 'TimeoutError', label: 'Listing', ms: 5000 });
	});

	it('cancelled is a singleton', () => {
		expect(cancelled._tag).toBe('UserCancelledError');
	});

	it('mkFirebaseAuth', () => {
		const r = mkFirebaseAuth('auth/wrong-password', 'Bad credentials');
		expect(r._tag).toBe('FirebaseAuthError');
		expect(r.code).toBe('auth/wrong-password');
		expect(r.message).toBe('Bad credentials');
	});
});

describe('displayError — exhaustive switch', () => {
	it('NetworkError', () => {
		expect(displayError(mkNetwork('fail'))).toBe('Network error: fail');
		expect(displayError(mkNetwork('fail', '/path'))).toBe('Network error (/path): fail');
	});

	it('StorageError', () => {
		expect(displayError(mkStorage('upload', 'a/b', 'err'))).toBe('Storage upload error at a/b: err');
	});

	it('LocalFileError', () => {
		expect(displayError(mkLocalFile('write', 'x.md', 'err'))).toBe('Local file write error at x.md: err');
	});

	it('CrdtError', () => {
		expect(displayError(mkCrdt('load', 'y.md', 'err'))).toBe('CRDT load error at y.md: err');
	});

	it('SettingsError without field', () => {
		expect(displayError(mkSettings(undefined, 'bad'))).toBe('Settings error: bad');
	});

	it('SettingsError with field', () => {
		expect(displayError(mkSettings('apiKey', 'bad'))).toBe('Settings error (apiKey): bad');
	});

	it('SyncError recurses into cause', () => {
		const cause = mkNetwork('root cause');
		expect(displayError(mkSync('x.md', cause))).toBe('Sync error at x.md: Network error: root cause');
	});

	it('UserCancelledError', () => {
		expect(displayError(cancelled)).toBe('Cancelled by user');
	});

	it('TimeoutError shows seconds', () => {
		expect(displayError(mkTimeout('Listing', 10_000))).toBe('Listing timed out after 10s');
	});

	it('FirebaseAuthError uses friendlyAuthCode when recognised', () => {
		const err = mkFirebaseAuth('auth/wrong-password', 'raw');
		expect(displayError(err)).toBe('Invalid email or password.');
	});

	it('FirebaseAuthError falls back to message when code unknown', () => {
		const err = mkFirebaseAuth('auth/unknown', 'raw message');
		expect(displayError(err)).toBe('raw message');
	});
});

describe('friendlyAuthCode', () => {
	it('returns empty string for unknown codes', () => {
		expect(friendlyAuthCode('auth/totally-unknown')).toBe('');
	});

	it('maps known codes', () => {
		expect(friendlyAuthCode('auth/invalid-email')).toBeTruthy();
		expect(friendlyAuthCode('auth/email-already-in-use')).toBeTruthy();
		expect(friendlyAuthCode('auth/weak-password')).toBeTruthy();
		expect(friendlyAuthCode('auth/too-many-requests')).toBeTruthy();
		expect(friendlyAuthCode('auth/network-request-failed')).toBeTruthy();
		expect(friendlyAuthCode('auth/configuration-not-found')).toBeTruthy();
	});
});
