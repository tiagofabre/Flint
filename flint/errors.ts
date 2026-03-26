export type NetworkError       = { readonly _tag: 'NetworkError';       readonly message: string; readonly path?: string };
export type StorageError       = { readonly _tag: 'StorageError';       readonly op: 'upload'|'download'|'delete'|'list'; readonly path: string; readonly message: string };
export type LocalFileError     = { readonly _tag: 'LocalFileError';     readonly op: 'read'|'write'|'create'|'delete'|'mkdir'; readonly path: string; readonly message: string };
export type CrdtError          = { readonly _tag: 'CrdtError';          readonly phase: 'load'|'save'|'merge'|'update'; readonly path: string; readonly message: string };
export type SettingsError      = { readonly _tag: 'SettingsError';      readonly field?: string; readonly message: string };
export type SyncError          = { readonly _tag: 'SyncError';          readonly path: string; readonly cause: FlintError };
export type UserCancelledError = { readonly _tag: 'UserCancelledError' };
export type TimeoutError       = { readonly _tag: 'TimeoutError';       readonly label: string; readonly ms: number };
export type FirebaseAuthError  = { readonly _tag: 'FirebaseAuthError';  readonly code: string; readonly message: string };

export type FlintError =
  | NetworkError | StorageError | LocalFileError | CrdtError
  | SettingsError | SyncError | UserCancelledError | TimeoutError | FirebaseAuthError;

// ── Smart constructors ────────────────────────────────────────────────────────

export const mkNetwork = (message: string, path?: string): NetworkError =>
	({ _tag: 'NetworkError', message, path });

export const mkStorage = (op: StorageError['op'], path: string, e: unknown): StorageError =>
	({ _tag: 'StorageError', op, path, message: e instanceof Error ? e.message : String(e) });

export const mkLocalFile = (op: LocalFileError['op'], path: string, e: unknown): LocalFileError =>
	({ _tag: 'LocalFileError', op, path, message: e instanceof Error ? e.message : String(e) });

export const mkCrdt = (phase: CrdtError['phase'], path: string, e: unknown): CrdtError =>
	({ _tag: 'CrdtError', phase, path, message: e instanceof Error ? e.message : String(e) });

export const mkSettings = (field: string | undefined, message: string): SettingsError =>
	({ _tag: 'SettingsError', field, message });

export const mkSync = (path: string, cause: FlintError): SyncError =>
	({ _tag: 'SyncError', path, cause });

export const mkTimeout = (label: string, ms: number): TimeoutError =>
	({ _tag: 'TimeoutError', label, ms });

export const cancelled: UserCancelledError = { _tag: 'UserCancelledError' };

export const mkFirebaseAuth = (code: string, message: string): FirebaseAuthError =>
	({ _tag: 'FirebaseAuthError', code, message });

// ── Display ───────────────────────────────────────────────────────────────────

export function displayError(e: FlintError): string {
	switch (e._tag) {
		case 'NetworkError':       return `Network error${e.path ? ` (${e.path})` : ''}: ${e.message}`;
		case 'StorageError':       return `Storage ${e.op} error at ${e.path}: ${e.message}`;
		case 'LocalFileError':     return `Local file ${e.op} error at ${e.path}: ${e.message}`;
		case 'CrdtError':          return `CRDT ${e.phase} error at ${e.path}: ${e.message}`;
		case 'SettingsError':      return `Settings error${e.field ? ` (${e.field})` : ''}: ${e.message}`;
		case 'SyncError':          return `Sync error at ${e.path}: ${displayError(e.cause)}`;
		case 'UserCancelledError': return 'Cancelled by user';
		case 'TimeoutError':       return `${e.label} timed out after ${e.ms / 1000}s`;
		case 'FirebaseAuthError':  return friendlyAuthCode(e.code) || e.message;
		default: {
			// Compile-time exhaustiveness guard: adding a new FlintError variant
			// without a case above produces a type error here.
			const _never: never = e;
			return `Unknown error: ${JSON.stringify(_never)}`;
		}
	}
}

/**
 * Returns true for any error that indicates the user is not authenticated.
 * These are expected when the user hasn't signed in yet and should be suppressed silently.
 */
export function isUnauthenticatedError(e: FlintError): boolean {
	const unauthKeywords = ['unauthorized', 'unauthenticated', 'permission-denied', 'not authenticated'];
	if (e._tag === 'StorageError') {
		return unauthKeywords.some(kw => e.message.toLowerCase().includes(kw));
	}
	if (e._tag === 'FirebaseAuthError') {
		return unauthKeywords.some(kw => e.code.toLowerCase().includes(kw) || e.message.toLowerCase().includes(kw));
	}
	if (e._tag === 'SyncError') {
		return isUnauthenticatedError(e.cause);
	}
	return false;
}

/** Maps Firebase auth error codes to user-friendly messages. Returns '' if code is unknown. */
export function friendlyAuthCode(code: string): string {
	if (code.includes('invalid-email')) return 'Invalid email address.';
	if (code.includes('user-not-found') || code.includes('wrong-password') || code.includes('invalid-credential')) return 'Invalid email or password.';
	if (code.includes('email-already-in-use')) return 'An account with this email already exists.';
	if (code.includes('weak-password')) return 'Password is too weak (minimum 6 characters).';
	if (code.includes('too-many-requests')) return 'Too many attempts. Please try again later.';
	if (code.includes('network-request-failed')) return 'Network error. Check your connection.';
	if (code.includes('configuration-not-found')) return 'Email/password sign-in is not enabled in Firebase.';
	return '';
}
