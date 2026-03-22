import { StorageReference, getStorage, ref } from 'firebase/storage';
import { initializeApp, getApps, FirebaseApp } from "firebase/app";
import { getAuth, Auth } from 'firebase/auth';
import { FirebaseStorage } from 'firebase/storage';

export let app: FirebaseApp | undefined;
export let storage: FirebaseStorage | undefined;
let storageRef: StorageReference | undefined;
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
	app = existingApps.length > 0 ? existingApps[0] : initializeApp(config);
	storage = getStorage(app);
	storageRef = ref(storage);
	vaultRef = undefined; // set per-user after sign-in via setUserVaultRef
	auth = getAuth(app);
}

export function setUserVaultRef(uid: string) {
	if (!storage) return;
	vaultRef = ref(storage, `users/${uid}/vaults`);
}
