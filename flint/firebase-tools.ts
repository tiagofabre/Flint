import { StorageReference, FirebaseStorage, getStorage, ref } from 'firebase/storage';
import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getAuth, Auth } from 'firebase/auth';

export function withTimeout<T>(promise: PromiseLike<T>, ms: number, label: string): Promise<T> {
	return Promise.race([
		Promise.resolve(promise),
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
		),
	]);
}

let storage!: FirebaseStorage;
export let vaultRef: StorageReference | undefined;
export let auth: Auth | undefined;

export interface FirebaseConfig {
	apiKey: string;
	authDomain: string;
	storageBucket: string;
	projectId: string;
	messagingSenderId: string;
	appId: string;
}

export function setupFirebase(config: FirebaseConfig) {
	const existingApps = getApps();
	const app: FirebaseApp = existingApps.length > 0 ? existingApps[0] : initializeApp(config);
	storage = getStorage(app);
	vaultRef = undefined; // set per-user after sign-in via setUserVaultRef
	auth = getAuth(app);
}

export function setUserVaultRef(uid: string) {
	vaultRef = ref(storage, `users/${uid}/vaults`);
}
