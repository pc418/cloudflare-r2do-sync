# R2DO Sync

Two-way Obsidian vault sync on **your own** Cloudflare account — no third-party service, no
subscription, end-to-end encrypted with a master key that never leaves your devices. The
free plan is enough for a text vault.

What makes it different is not the hosting. It is that syncing is built like version
control, not like a file copier — and that is why it does not lose notes.

## Built like version control

Most sync plugins walk both sides, compare timestamps and sizes, consult a private "what I
saw last time" database, and guess. Newer wins, so one side is silently discarded.
Deletions are inferred, not observed. A wrong mtime — which their own docs admit happens —
reads as a change or hides one. And when two devices upload at once, nothing orders them:
the results interleave. There is no shared history, so there is nothing to merge against
and nothing to restore.

R2DO Sync keeps a commit log instead:

- **Every sync publishes a commit** — a complete snapshot of the vault, as an encrypted
  manifest naming every file by the hash of its content, plus the id of the snapshot it
  grew from.
- **One authority orders the commits.** A Durable Object holds the current head and accepts
  a commit only if its parent is still that head. When two devices publish at once, exactly
  one wins; the other pulls, merges, and retries. The history is linear by construction —
  no device can clobber another's work, because the server refuses the commit that would.
- **Pull → merge → commit, never the other way.** Before a device may publish, it absorbs
  the current head and three-way merges (diff3) against the snapshot both sides actually
  share — a real common ancestor, not a heuristic. Two devices appending to the same daily
  note both keep their lines, in order, and both compute the same result.
- **Decisions come from content hashes, never clocks.** A bad timestamp cannot fake a
  change or hide one. Deletions are stated by the snapshot, not inferred from a side
  database that can go stale.
- **Content addressing keeps it cheap.** Each unique (encrypted) content is stored once; a
  commit uploads only what changed. History costs metadata, not copies of your notes.
- **History is real.** Any snapshot restores — one file or the whole vault — and nightly
  garbage collection trims old ones on your schedule.

Cloudflare's pieces map onto this exactly: the **Worker** is the API, **R2** stores the
encrypted blobs and manifests, and the **Durable Object** is the single point where commits
serialize. All of it runs in your account; the server stores ciphertext and an opaque path
map, and never sees a filename or a key.

## What you need

- A Cloudflare account (free plan), Node.js 20+, Obsidian, 5 minutes.

## Setup

```bash
git clone https://github.com/pc418/cloudflare-r2do-sync.git && cd cloudflare-r2do-sync
npm --prefix worker install && npm --prefix plugin install
node scripts/setup.mjs
```

Log in first, if you have not already, with the wrangler this repo pins —
`./worker/node_modules/.bin/wrangler login`. Setup uses only that copy and never logs you
in or out. It prints **which account** it is about to deploy to and waits for you to
confirm, then creates the R2 bucket, deploys the Worker, sets the admin secret, schedules
nightly garbage collection, smoke-tests `/health`, and issues your access token. Every step
is idempotent — re-running after a failure resumes. Every run ends with a fresh access
token; the admin credential behind it lives in gitignored `.env`, managed for you.

```
════════════════════════════════════════════════════════════════════
  PASTE THESE INTO OBSIDIAN
════════════════════════════════════════════════════════════════════

  Server URL   https://obsidian-log-sync.<your-subdomain>.workers.dev
  Access token <64 hex characters>
  ...
```

Then install the plugin (or, once the community listing is live, install **R2DO Sync** from
Settings → Community plugins — the Worker is yours to deploy either way, because there is
no service behind this plugin other than your own account):

```bash
cd plugin && node build.mjs && cd ..
node scripts/install-plugin.mjs "/path/to/Your Vault"
```

1. Obsidian → Settings → Community plugins → enable **R2DO Sync**.
2. The **Set up sync** panel takes the printed **Server URL** and **Access token**, plus a
   **Device name** (conflict copies are named after it). **Test connection** checks them
   before anything syncs.
3. R2DO Sync generates a random vault master key before the first upload and opens the
   required backup window. Copy the key into your password manager and press **I saved
   it** — sync stays disabled until you do. Then press **Sync now**.

The random key is recommended. **Set from passphrase** derives the same 256-bit key on any
device (PBKDF2-SHA256, 600,000 iterations, public per-vault salt), but a weak passphrase is
open to offline guessing. Only the derived key is stored.

### Adding another device

On the configured device, open **Set up another device**. It exports the server URL, token
and master key two ways — **Show QR** for a phone (the code is an `obsidian://` link the
camera app opens directly) and **Copy setup link** for anything else, pasted into the new
device with **Apply a setup link**. Nothing is typed by hand.

**Set the new device up before its first sync.** Typing the URL and token in manually
cannot work on an encrypted vault — neither carries the master key, so the device would
generate its own and be rejected. It halts and offers the paste box instead; that halt is
the safety net working.

A new device that already holds a copy of the vault is fine: identical files match by
content hash, notes both sides created merge, and anything ambiguous keeps both copies.
Nothing local is deleted on a first sync.

### On a phone

Before the community listing appears, let a computer do the install once: set the vault up
on a desktop, then zip the whole vault folder, transfer it, and unzip it inside Obsidian's
folder on the phone. The hidden `.obsidian` folder travels inside the zip even on iOS. The
copy carries plugin, settings and keys — just change **Device name** afterwards. (Android
can instead copy the three `plugin/dist/` files into
`YourVault/.obsidian/plugins/cloudflare-rdo-sync/` and set up by QR as usual.)

Once running, the **ribbon icon** is the sync button — its tooltip carries the same state
the desktop status bar shows. Every pass ends in a notice, background ones and "up to date"
included, so a tap is never silently ignored; the **Notices** toggles narrow or silence
them. A device configured by QR or link starts its first sync immediately after the
one-time backup confirmation, and returning to the app counts as startup — if the last
pass is older than your sync interval, a sync runs.

### Deploying without wrangler

For CI, or a machine whose wrangler is signed in to a different account: copy
`.env.example` to `.env`, fill in `CLOUDFLARE_TOKEN` (scopes: *Workers Scripts:Edit*,
*Workers R2 Storage:Edit*) and `CLOUDFLARE_ACCOUNT_ID`, then `node scripts/setup.mjs
--token`. With both credentials present this path is chosen automatically; the script never
silently switches accounts.

## Security model

- **Encryption happens on the device.** Contents and paths are AES-256-GCM encrypted with
  keys derived (HKDF) from one 256-bit master key. The server sees blob hashes and an
  encrypted path map. Blob names are `sha256(ciphertext)`, so it can verify integrity
  without reading anything.
- **The master key never leaves your devices** — not in `.env`, not on the server, not
  recoverable by anyone including you. Keep a copy (Settings → copy master key) somewhere
  safe.
- A passphrase-derived key uses a public per-vault salt, shared through setup links; a
  conflicting salt is rejected rather than silently deriving a different key.
- Plugin settings (`<config folder>/plugins/cloudflare-rdo-sync/**`, the legacy
  `plugins/obsidian-log-sync/**`) and `workspace*.json` are never synced — `data.json`
  holds this device's token and master key in plaintext. A renamed config folder is skipped
  along with `.obsidian`, since the rename leaves the old copy on disk.
- **Installed plugins, themes and CSS snippets are never synced**, even with config-folder
  sync on: Obsidian executes those, so syncing them would let anyone who can write to your
  vault run code on all your devices — and `plugins/<id>/data.json` is where your *other*
  plugins keep credentials. Obsidian's own settings files still sync.
- **What the server can still tell:** file count, rough sizes, sync times, device names,
  and that two paths hold identical content (that is what deduplication is). Not contents,
  not paths.
- **Other software on your device is trusted.** The key and token sit in the plugin's
  `data.json` in plaintext because the plugin needs them; any other plugin can read them.
  "Encrypted" means the *server* cannot read your notes, not a sandbox on your own machine.
- **Setup links and QR codes contain the key**, base64-encoded. Treat one like the key
  itself, and remember the clipboard is not private storage.
- **Snapshot history is not a backup.** It protects against your own mistakes, not against
  losing the account, bucket, or key — those take every snapshot at once. Keep an
  independent export: `scripts/restore.mjs` decrypts a snapshot without the plugin.
- **Your data stays your responsibility.** There is no operator who can read your notes
  back or restore them for you. The plugin is provided as-is under the PolyForm Small
  Business 1.0.0 license, without warranty; the first-run panel and first-sync prompt both
  say so.

## Tokens

Two credentials, deliberately separate — there are no device accounts:

| | what it does | where it lives |
|---|---|---|
| **Access token** | read/write the vault | every device, in plugin settings and QR codes |
| **Admin token** | issue and revoke access tokens; cannot read the vault | `.env`, managed by the scripts |

One access token shared by all devices is the normal setup. The split makes recovery cheap:
a lost device or leaked token is one revocation, no redeploy. If `.env` is lost, re-running
setup rotates the admin credential without touching access tokens.

```bash
node scripts/access-token.mjs                  # issue it — replaces the existing one
node scripts/access-token.mjs --list           # active tokens (no token material)
node scripts/access-token.mjs --rotate         # fresh token, revokes ALL others
node scripts/access-token.mjs --name phone     # an extra token, revocable on its own
node scripts/access-token.mjs --revoke <id>
node scripts/access-token.mjs --out token.json # 0600 file instead of the screen
```

A token prints only to a terminal; piped into a file or CI log it refuses (use `--out` or
`--print-token`). Replacing a token kills the old one immediately — devices holding it stop
syncing until they get the new one, which is the point of re-issuing.

A token can also be issued with less than full authority — without the `reroot` scope
(rebuilding remote history is the only action that makes remote content stop existing) or
with an expiry:

```bash
curl -X POST "$WORKER_URL/api/tokens" -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"phone","scopes":["sync"],"expiresAt":"2027-01-01T00:00:00Z"}'
```

## How syncing behaves

- **Merges are line by line** (diff3). Two devices appending to the same note at the same
  point keep both additions, ordered by text — for dated log lines that is date order.
- **Conflicts keep both sides, then let you choose.** The remote copy lands beside yours as
  `note.conflict-<device>-<yymmdd-HHmm>.md`; nothing is overwritten in place. A window (on a
  sync you started; a notice otherwise) shows the line-by-line difference with four choices:
  keep this device's, keep the other's, keep both files, or **combine into one** with the
  disagreements marked (`<<<<<<< this device` / `>>>>>>> other device`, `(newer)` labelled)
  for you to edit — the only case where markers are ever written. Background syncs park the
  copy and wait; **Review and resolve conflicts** reopens the latest batch any time.
- **Optional: let conflicts overwrite.** *Newest wins* or *largest wins* picks the same
  winner on every device and discards the loser (the remote side stays in snapshot
  history). Enabling either asks for a second confirmation.
- **Edits beat deletes** in both directions — a deletion is easy to redo, an edit is not.
- **Every pass says what it moved** — "3 files, +35 lines" out, "1 file, -7 lines" in; an
  optional toggle names each file with the snapshot id.
- **A file you edit mid-sync does not fail the sync.** The pass notices, rescans, and
  publishes what you actually have; only a file changing continuously across several
  rescans gives up, publishing nothing.
- **Mass-change guard.** A pull that would delete more than half of this device's files
  (threshold in settings) stops and asks: apply remote, keep local, or decide later.
  Unattended syncs never decide for you.
- **First sync asks once** per device to confirm you have a copy of the vault; until
  answered the status reads `CONFIRM FIRST SYNC` rather than pretending to be up to date.
- **Continuity check.** Before merging a snapshot it has not seen, a device traces it back to
  the one it last synced. Usually that is the snapshot's own parent and costs nothing. If the
  trail runs out — the history was rebuilt, or this device has been away longer than the
  server keeps history — the pass stops and asks instead of merging a history it cannot
  place. Unattended syncs never answer it, and stopping publishes nothing. On an encrypted
  vault every link the check follows is authenticated with the vault key, so the trail
  cannot be forged by whoever serves it.
- **Preview, history, log.** **Preview sync** shows what a pass would change without
  changing anything; **Snapshot history** browses and restores past snapshots; **Sync log**
  exports recent passes to a note. **Sync hotkey** in settings binds "Sync now" (`⇧⌘S`
  offered when free).
- **Forcing a direction**, when one side is simply wrong: **Pull remote over local** makes
  this vault match the remote head, keeping unpublished local changes as `.conflict-…`
  copies; **Push local over remote** publishes this device's files without merging. Both
  preview what they will touch and require a typed confirmation, and the replaced snapshot
  stays in history.
- **Selective and one-way policies.** An optional allow-list of globs; **Pull-only**
  applies remote changes but never commits; **Push-only (backup)** never writes local
  files. Paths outside the allow-list are carried remotely, not deleted.
- Your config folder is local by default; syncing it requires a typed `SYNC CONFIG`
  confirmation, and the credential folders and `workspace*.json` stay hard-skipped even then.
- Changing the encryption mode or key is a separate `REKEY` operation that transforms the
  complete remote snapshot in one commit; ordinary sync halts on a key/mode mismatch
  instead of mixing ciphertext and plaintext.

### Tuning

| Setting | Default | Trade |
|---|---|---|
| **Parallel lanes** | 4 | Files processed at once; higher is faster but heavier on a phone or slow link |
| **Sync log length** | 50 | Passes kept for troubleshooting |
| **Snapshots listed in history** | 40 | Each one is a request |
| **Automatic retries** | 3 | Backoff after a failed pass; a *halted* sync is never retried — it needs a person |
| **Sync settings between devices** | on | Shares vault-wide settings through the server, encrypted like notes; most recent change wins |

Vault-wide settings (excludes, thresholds, intervals, direction, notices, the public salt…)
sync between devices. Credentials, **Device name**, **Parallel lanes**, and config-folder
consent deliberately stay per-device.

## Restore outside Obsidian

`scripts/restore.mjs` decrypts any snapshot to a plain directory — no Obsidian, no plugin:

```bash
node scripts/restore.mjs --out ./restored              # current head
node scripts/restore.mjs --out ./restored --head <manifest-id>
node scripts/restore.mjs --out ./restored --passphrase --salt <public-vault-salt>
```

It prompts for the access token and master key (or reads `ACCESS_TOKEN` / `MASTER_KEY`), so
neither lands in shell history. It re-implements the crypto independently on purpose, and a
test keeps the two byte-compatible — a bug in the plugin cannot make your backups
unreadable.

## Limits

- 100 MiB per file (Workers request-body limit); larger files are skipped and reported.
- 100,000 files per snapshot.
- Merge granularity is a line; two edits inside one line conflict.
- Nightly garbage collection (04:00 UTC) keeps the last 50 snapshots **or** 30 days of
  them, whichever reaches further back, plus every blob they reference. Both numbers are
  `GC_KEEP_COUNT` / `GC_KEEP_DAYS` in `worker/wrangler.jsonc`; edit them and redeploy.
  Retained snapshots restate the whole path map, so this — not file content — is usually
  what a vault's storage is spent on. Shrinking it also shortens how long a device can be
  offline and still merge cleanly against a shared base.
- One vault per deployment.

## Development

```bash
# All commands are run from the repository root.
npm --prefix worker install && npm --prefix plugin install

npm --prefix worker test             # 156 tests, real workerd via vitest-pool-workers
npm --prefix plugin test             # 814 tests, incl. rendered settings-tab/modal coverage
node --test scripts/*.test.mjs       # 56 tests: deploy/setup/release/token helpers
npm --prefix plugin run lint         # typed lint; the baseline is zero, so any finding is new
npm --prefix worker run lint

npm --prefix plugin run build        # -> plugin/dist/{main.js,manifest.json,styles.css}
node scripts/release-validate.mjs 0.3.0   # release layout check; must run from the root
```

`worker/wrangler.jsonc` is the single source of deployment metadata for both deploy paths.
A release is cut by pushing a tag equal to the `manifest.json` version:
`.github/workflows/release.yml` runs the suites, builds, attests the assets and publishes
`main.js`, `manifest.json` and `styles.css` on the GitHub release.

## License

[PolyForm Small Business 1.0.0](https://polyformproject.org/licenses/small-business/1.0.0) —
see [LICENSE](LICENSE). Personal use is unrestricted; use *for the benefit of a company* is
permitted only for small businesses as the license defines them. Source-available, not OSI
open source. 

## Support

Your privacy, now verified. How much does it worth?

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/F1F11WRQDT)
