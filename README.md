# Flint

Obsidian plugin that syncs your vault across devices using your own Firebase Storage bucket. Concurrent edits from multiple devices are merged automatically using [Automerge](https://automerge.org/) CRDTs — no conflicts, no lost work.

## Features

- **CRDT sync** — concurrent edits from different devices are merged, not overwritten.
- **Bring-your-own Firebase** — your data lives in your bucket; no third-party server involved.
- **Firebase Authentication** — sign in with email/password to scope reads/writes to your account.
- **Force Push** — command-palette escape hatch to overwrite remote state with local vault.
- **Android/Mobile compatible.**

## Setup

### Firebase Project

1. Create a new project at [console.firebase.google.com](https://console.firebase.google.com).
2. Register a **Web App** (Project Settings → Your apps → Add app) and copy the `firebaseConfig` values.
3. Enable **Firebase Storage** (Build → Storage → Get started). Choose a region, start in production mode.
4. Enable **Email/Password** authentication (Build → Authentication → Sign-in method → Email/Password → Enable).
5. Create a user account (Authentication → Users → Add user).
6. Set your Storage rules:
   ```
   rules_version = '2';
   service firebase.storage {
     match /b/{bucket}/o {
       match /vaults/{vaultName}/{allPaths=**} {
         allow read, write: if request.auth != null
                            && request.auth.token.email != null;
       }
     }
   }
   ```
7. Configure CORS on your bucket. Create a `cors.json` file:
   ```json
   [
     {
       "origin": ["app://obsidian.md"],
       "method": ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"],
       "responseHeader": ["Content-Type", "Authorization", "Content-Length", "X-Requested-With"],
       "maxAgeSeconds": 3600
     }
   ]
   ```
   Apply it with: `gsutil cors set cors.json gs://YOUR-BUCKET-NAME`

### Plugin Installation

1. Enable Community Plugins in Obsidian settings.
2. Search for **Flint** and install, or manually copy the plugin folder into `VAULT/.obsidian/plugins/`.
3. Enable the plugin under Community Plugins.

### Plugin Configuration

1. Open **Settings → Flint**.
2. Paste your Firebase `firebaseConfig` values and click **Save**.
3. Enter your email/password and sign in.

## Usage

**Sync** — click the refresh icon in the left ribbon. Flint merges your local files with remote state and uploads the result. The first sync uploads everything; subsequent syncs are incremental.

**Force Push** — open the Command Palette (`Cmd/Ctrl + P`) and run **Flint: Force push vault to Firebase** to overwrite remote state with your local vault, skipping the merge step.

**New device** — configure Flint with the same Firebase credentials and click Sync. Your notes will be downloaded and merged into the local vault.

## Storage Layout

```
vaults/
  <vault-name>/
    path/to/note.md        ← Markdown with _flint_id frontmatter
    path/to/note.md.am     ← Automerge binary (CRDT state)
```

## Troubleshooting

- **CORS errors** — apply the CORS config to your bucket (step 7 above).
- **`auth/configuration-not-found`** — Email/Password sign-in is not enabled in Firebase Console.
- **No changes after sync** — check that your Storage rules allow authenticated writes and that the bucket name in settings matches exactly.
