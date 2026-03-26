import { StorageReference, FirebaseStorage, getStorage, ref } from 'firebase/storage';
import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getAuth, Auth } from 'firebase/auth';
import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { FlintError, mkNetwork, mkTimeout } from 'errors';

// ── Timeout helpers ───────────────────────────────────────────────────────────

export function withTimeout<T>(promise: PromiseLike<T>, ms: number, label: string): Promise<T> {
	return Promise.race([
		Promise.resolve(promise),
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
		),
	]);
}

export function withTimeoutTE<A>(promise: Promise<A>, ms: number, label: string): TE.TaskEither<FlintError, A> {
	return TE.tryCatch(
		() => withTimeout(promise, ms, label),
		(e): FlintError => {
			if (e instanceof Error && e.message.includes('timed out')) return mkTimeout(label, ms);
			return mkNetwork(e instanceof Error ? e.message : String(e));
		}
	);
}

// ── Firebase state ────────────────────────────────────────────────────────────

export interface FirebaseConfig {
	apiKey: string;
	authDomain: string;
	storageBucket: string;
	projectId: string;
	messagingSenderId: string;
	appId: string;
}

interface FirebaseState {
	readonly auth: Auth;
	readonly storage: FirebaseStorage;
	readonly userVaultRef: O.Option<StorageReference>;
}

let _state: O.Option<FirebaseState> = O.none;

export function setupFirebase(config: FirebaseConfig): E.Either<FlintError, void> {
	try {
		const existingApps = getApps();
		const app: FirebaseApp = existingApps.length > 0 ? existingApps[0] : initializeApp(config);
		const storage = getStorage(app);
		const auth = getAuth(app);
		_state = O.some({ auth, storage, userVaultRef: O.none });
		return E.right(undefined);
	} catch (e) {
		return E.left(mkNetwork(e instanceof Error ? e.message : String(e)));
	}
}

export function setUserVaultRef(uid: string): E.Either<FlintError, void> {
	if (O.isNone(_state)) return E.left(mkNetwork('Firebase not initialised'));
	const state = _state.value;
	_state = O.some({
		...state,
		userVaultRef: O.some(ref(state.storage, `users/${uid}/vaults`)),
	});
	return E.right(undefined);
}

export function requireFirebaseState(): E.Either<FlintError, { auth: Auth; storage: FirebaseStorage; userVaultRef: StorageReference }> {
	if (O.isNone(_state)) return E.left(mkNetwork('Firebase not initialised'));
	const state = _state.value;
	if (O.isNone(state.userVaultRef)) return E.left(mkNetwork('Firebase user vault ref not set — sign in first'));
	return E.right({ auth: state.auth, storage: state.storage, userVaultRef: state.userVaultRef.value });
}

export function getFirebaseAuth(): E.Either<FlintError, Auth> {
	if (O.isNone(_state)) return E.left(mkNetwork('Firebase not initialised'));
	return E.right(_state.value.auth);
}
