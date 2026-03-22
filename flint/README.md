# Flint

**Flint** is an Obsidian plugin that syncs your vault across devices using [Firebase Storage](https://firebase.google.com/products/storage) as the backend. It uses [Automerge](https://automerge.org/) CRDTs for conflict-free merging when multiple devices edit the same note simultaneously.

---

## Features

- **Cross-device sync** — notes are stored in your own Firebase Storage bucket; no third-party server has access to your data.
- **CRDT conflict resolution** — concurrent edits from different devices are merged automatically using Automerge, so you never lose work.
- **Bring-your-own Firebase** — you control the bucket and the auth rules. Flint never touches a server you don't own.
- **Incremental sync** — only changed files are uploaded or downloaded on each sync cycle.

---

## Prerequisites

1. A [Firebase project](https://console.firebase.google.com/) with **Storage** and **Authentication** enabled.
2. Email/password authentication turned on in Firebase Auth (used to scope reads/writes to the signed-in user).
3. Firebase Storage security rules that protect your data (see [Recommended Rules](#recommended-storage-rules) below).

---

## Setup Guide

### 1. Create a Firebase project

1. Go to [https://console.firebase.google.com/](https://console.firebase.google.com/) and click **Add project**.
2. Give the project a name and follow the wizard. You do not need Google Analytics.

### 2. Enable Firebase Storage

1. In the Firebase console, open **Build → Storage**.
2. Click **Get started** and choose a region close to you.
3. Start in **production mode** (you will tighten the rules in a moment).

### 3. Enable Email/Password Authentication

1. In the Firebase console, open **Build → Authentication**.
2. Click **Get started**, then choose **Email/Password** and enable it.
3. Create at least one user account via **Users → Add user**.

### 4. Grab your Firebase config

1. In the Firebase console, click the gear icon → **Project settings**.
2. Under **Your apps**, click the `</>` (web) icon to register a web app.
3. Copy the `firebaseConfig` object. You will need these values:
   - `apiKey`
   - `authDomain`
   - `projectId`
   - `storageBucket`
   - `messagingSenderId`
   - `appId`

### 5. Configure Flint in Obsidian

1. In Obsidian, open **Settings → Community plugins** and enable Flint.
2. Open **Settings → Flint**.
3. Paste each value from the `firebaseConfig` into the corresponding field.
4. Enter the email and password for the Firebase Auth user you created.
5. Click **Save**.

---

## How to Use

### Syncing your vault

Click the **Sync** ribbon icon (refresh arrows) on the left sidebar. Flint will:

1. Sign in to Firebase with your credentials.
2. Walk every `.md` file in your vault.
3. For each file, merge the local Automerge doc with the remote copy stored in Firebase Storage.
4. Upload the merged result.

The first sync uploads all files; subsequent syncs only transfer diffs.

### Force Push

If you want to overwrite the remote state with your local vault (e.g. after a manual fix), open the Command Palette (`Cmd/Ctrl + P`) and run **Flint: Force push vault to Firebase**. This skips the merge step and uploads your local files directly.

### Importing a vault on a new device

1. Install Flint and configure it with the same Firebase project credentials.
2. Click the **Sync** ribbon icon.
3. Flint will download all notes from Firebase and merge them into your local vault.

---

## Recommended Storage Rules

Paste the following into **Firebase console → Storage → Rules** to ensure users can only access their own files:

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

For stricter rules, scope to a specific email address:

```
allow read, write: if request.auth.token.email == "you@example.com";
```

---

## Firebase Storage Layout

```
vaults/
  <vault-name>/
    path/to/note.md          ← Markdown with _flint_id frontmatter
    path/to/note.md.am       ← Automerge binary (CRDT state)
```

Each note gets a companion `.md.am` file that tracks its full edit history for merging.

---

## Known Limitations

- **Self-hosted Firebase only** — you must supply your own Firebase project and credentials. There is no hosted Flint service.
- **Markdown files only** — binary attachments (images, PDFs, etc.) are not synced.
- **No real-time sync** — sync is triggered manually via the ribbon icon or on plugin load. There is no background polling.
- **Large vaults** — the initial sync of a large vault may take a while due to Firebase Storage upload limits and Automerge doc serialization overhead.

---

## License

MIT — see [LICENSE](../LICENSE).
