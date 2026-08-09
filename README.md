# R2DO Sync

Two-way Obsidian vault sync on **your own** Cloudflare account. Every sync publishes a
content-addressed snapshot of the whole vault to R2 behind a Worker; the plugin pulls,
merges, and only then commits. Files are encrypted on the device — the server stores
ciphertext and an opaque path map, and never sees a filename or a key.

Built for the daily-log case: two devices appending to the same note on the same day merge
into one note, in date order, instead of fighting over it.

- No third-party service, no subscription. Cloudflare's free plan is enough for a text vault.
- End-to-end encrypted with a master key that never leaves your devices.
- Conflicts never lose data: unmergeable pairs keep **both** sides side by side.

## What you need

- A Cloudflare account (free plan).
- Node.js 20+ and Obsidian.
- 5 minutes.

## Setup

```bash
git clone https://github.com/pc418/cloudflare-r2do-sync.git && cd cloudflare-r2do-sync
npm --prefix worker install && npm --prefix plugin install
node scripts/setup.mjs
```

Log in first with `npx wrangler login` if you have not already — setup never logs you in or
out, so the account it uses is always one you chose. It prints **which account** it is about
to deploy to and waits for you to confirm, then creates the R2 bucket, deploys the Worker,
sets the admin secret, schedules the nightly garbage collection, smoke-tests `/health`, and
issues your access token. Every step is idempotent, so re-running it after a failure resumes
instead of duplicating.

It ends by printing the only two values you handle yourself — the ones you type into
Obsidian. **Every run ends with a fresh access token**, first setup or redeploy alike: the
server-side admin credential that issues it is managed for you in `.env` (gitignored),
reused while it still works and rotated when it does not.

```
════════════════════════════════════════════════════════════════════
  PASTE THESE INTO OBSIDIAN
════════════════════════════════════════════════════════════════════

  Server URL   https://obsidian-log-sync.<your-subdomain>.workers.dev
  Access token <64 hex characters>
  ...
```

Then install the plugin and finish in the app. Once the community listing is live you can
instead install **R2DO Sync** from Settings → Community plugins → Browse and skip to step 1
below — the Worker above is yours to deploy either way, because there is no service behind
this plugin other than your own Cloudflare account.

```bash
cd plugin && node build.mjs && cd ..
node scripts/install-plugin.mjs "/path/to/Your Vault"
```

1. Obsidian → Settings → Community plugins → enable **R2DO Sync**.
2. A device with no credentials opens on a **Set up sync** panel naming the two ways in and
   what self-hosting puts on you. This is the first device, so use the fields under it: the
   **Server URL** and **Access token** from the printed block, plus a **Device name** (any
   label you like — it is what conflict copies are named after). **Test connection**, beside
   those two fields, checks them against the server before anything syncs. The rest of the
   settings page appears once both are in — nothing there can act without them.
3. R2DO Sync generates a random vault master key before the first upload and opens the
   required backup window. Copy the key into your password manager and press **I saved
   it**; sync stays disabled until you do. Then press **Sync now**.

The random key is recommended. **Set from passphrase** derives the same 256-bit key on any
device using PBKDF2-SHA256 (600,000 iterations) and a per-vault public salt, but a weak
passphrase is vulnerable to offline guessing. Only the derived key is stored; the
passphrase is discarded.

### Adding another device

On the configured device, open **Set up another device**. It exports the same payload — the
server URL, the token and the master key — two ways, and nothing is ever typed by hand:

- **Show QR**, for a phone. Scan it with the phone's own camera app; the code encodes an
  `obsidian://` link, so Obsidian opens directly.
- **Copy setup link**, for anything that cannot scan a code — a second computer, most
  obviously. Paste it into the new device with **Apply a setup link**.

**Set the new device up before its first sync.** Without the master key it cannot read the
vault, and it will stop rather than guess — that halt is the safety net working.

Typing the server URL and access token into a new device by hand **cannot** work on an
encrypted vault: neither of them carries the master key, so the device generates one of its
own and is rejected. The **Set up sync** panel says this before you try and offers **Paste
setup link** beside the warning; if you type them in anyway, the same offer reappears at the
top of the settings page once the device is refused — that is the whole fix.

**Apply a setup link → Paste link** on the new device (or the "Apply a setup link (paste)"
command) takes the whole `obsidian://…` link or just its payload, and refuses anything it
cannot use instead of half-configuring the device. Use it with a copied link, and also when
a phone's scanner opens the link in a browser instead of Obsidian — copy it from the address
bar and paste it here.

A new device that already holds a copy of the vault (or part of one) is fine: identical
files are recognised by content hash and do nothing, notes that both sides created merge,
and anything ambiguous keeps both copies. Nothing local is deleted on a first sync.

### On a phone

**Getting the plugin onto the phone manually** (for example, before the community listing
appears; phones cannot run the install script): let a computer do it once. Set the vault up
on a desktop first — plugin installed, synced, working — then copy the whole vault folder
to the phone: zip it, send it over (AirDrop, USB, any file transfer), and unzip it inside
Obsidian's folder on the phone, then open it as a vault. The hidden `.obsidian` folder
travels inside the zip even on iOS, where the Files app refuses to show it — which is also
why creating the folders by hand only works on Android. The copy carries the plugin, the
server settings and the keys, so there is nothing to scan or type; just change **Device
name** in settings afterwards so conflict copies name the right device. (On Android you can
instead copy the three files from `plugin/dist/` into
`YourVault/.obsidian/plugins/cloudflare-rdo-sync/` and set it up by QR or link as usual.)

Once it runs: there is no status bar on mobile, so the **ribbon icon** is the sync button —
tap it to sync, and its tooltip carries the same state the desktop status bar shows. Every
pass ends in a notice — background ones too, and including "up to date" — so a tap is never
silently ignored and a quiet plugin is never mistaken for a working one. Three toggles under
**Notices** shape that: turn notices off entirely, narrow them to passes that changed
something, or have them name each changed file. The command palette has the same actions
("Sync now", "Preview sync", "Browse snapshot history").

Two things happen on their own: a device configured by QR or pasted link **starts its first
sync immediately** (after the one-time "back up this vault first" confirmation), and on
mobile, **returning to the app counts as startup** — phones
suspend Obsidian rather than close it, so when the app becomes visible again and the last
pass is older than your sync interval, a sync runs (obeys **Sync on startup**).

### Deploying without wrangler

For CI, or a machine whose wrangler is signed in to a different account, use the REST path:
copy `.env.example` to `.env`, fill in `CLOUDFLARE_TOKEN` (scopes: *Workers Scripts:Edit*,
*Workers R2 Storage:Edit*) and `CLOUDFLARE_ACCOUNT_ID`, then run `node scripts/setup.mjs
--token`. With both credentials present that path is chosen automatically. The two paths
can be two different accounts, so the script never silently switches between them.

## Security model

- **Encryption happens on the device.** Contents and paths are AES-256-GCM encrypted with
  keys derived from one 256-bit master key (HKDF). The server sees blob hashes and an
  encrypted path map.
- **The master key never leaves your devices.** It is not in `.env`, not on the server, not
  recoverable by anyone including you. Lose every device that has it and the backup is
  unreadable — keep the key (Settings → copy master key) somewhere safe.
- A passphrase-derived key uses a public per-vault salt. The salt is shared through setup
  links and the settings document; it is not secret. A conflicting salt is rejected rather
  than silently deriving a different key.
- Blob names are `sha256(ciphertext)`, so the server can still verify integrity without
  being able to read anything.
- Plugin settings (`.obsidian/plugins/cloudflare-rdo-sync/**`) and `workspace*.json` are
  never synced: `data.json` holds this device's access token and master key in plaintext.
  The old `.obsidian/plugins/obsidian-log-sync/**` credential directory is also
  permanently skipped so a leftover legacy `data.json` can never enter a snapshot.
- **Your data stays your responsibility.** Nothing here is a service: there is no operator
  and no support channel that can read your notes back to you or restore them on your
  behalf. Your own backups and your own master key are part of running this, and the plugin
  is provided as-is under the MIT license, without warranty. The first-run panel and the
  first-sync prompt both say so, and the prompt has to be answered before anything uploads.

## Tokens

There are no device accounts to manage — just two credentials, deliberately separate:

| | what it does | where it lives |
|---|---|---|
| **Access token** | read/write the vault | every device, in plugin settings and QR codes |
| **Admin token** | issue and revoke access tokens; cannot read the vault | `.env`, managed by the scripts — you never handle it |

One access token shared by all devices is the normal setup — that is what the QR does. The
split is what makes recovery cheap: if a device is lost or the token leaks, one command
revokes it. No redeploy, and nothing for you to keep in a password manager — if `.env` is
ever lost or stale, re-running `node scripts/setup.mjs` rotates the admin credential and
carries on (existing access tokens are unaffected by that rotation).

```bash
node scripts/access-token.mjs                  # issue it — replaces the existing one
node scripts/access-token.mjs --list           # active tokens (no token material)
node scripts/access-token.mjs --rotate         # fresh token, revokes ALL others
node scripts/access-token.mjs --name phone     # an extra token, revocable on its own
node scripts/access-token.mjs --revoke <id>
```

Running the issue command twice replaces the token rather than leaving two live ones, so
there is no state to clean up if you lose track. Either way the old token dies immediately:
devices still holding it stop syncing until you paste the new one (or scan a fresh QR).
That is the point of re-issuing — you do it because the old token is no longer trusted.

These commands read `ADMIN_TOKEN` from `.env`, where setup put it; nothing is typed and
nothing appears in shell history. (Prefer keeping it out of `.env`? Delete the line — the
commands then ask for it with hidden input.)

## How syncing behaves

- **Snapshots, not diffs.** Each commit is a whole-vault manifest with a parent; the Worker
  accepts it only if the parent is still the head (compare-and-set in a Durable Object).
- **Pull → merge → commit, never the other way round.** Notes merge line by line (diff3).
  Two devices appending to the same note at the same point keep both additions, ordered by
  text — for dated log lines that is date order, and both devices compute the same result.
- **Conflicts keep both sides, then let you choose.** The remote copy lands beside yours as
  `note.conflict-<device>-<yymmdd-HHmm>.md`; nothing is overwritten in place. Every conflict is
  announced — a window when you started the sync, a notice otherwise — and that window shows
  the **line-by-line difference** between the two versions with four choices per file: keep
  this device's, keep the other device's, keep both as separate files, or **combine them into
  one file** with the disagreements marked for you to edit. The newer edit is labelled
  `LATEST` and its button is the default. Nothing is decided for you and nothing is decided
  during a background sync: the copy is parked first, so the choice waits as long as you like.
  **Review and resolve conflicts** (command palette, or **Safety → Unresolved conflicts**)
  reopens the latest batch any time.
- **Combining is the only thing that writes markers into a note**, and only for the file you
  asked. Lines the two versions agree on appear once; each disagreement is wrapped in
  `<<<<<<< this device` / `=======` / `>>>>>>> other device`, with `(newer)` on whichever side
  was edited last. Ordinary sync never writes a marker.
- **Optional: let conflicts overwrite.** **Conflict handling** (under Safety) can switch
  from "Keep both" to *newest wins* or *largest wins*: every device picks the same winner
  and the loser is discarded instead of parked. Changing it asks for a second
  confirmation, because a losing local edit that was never synced is gone for good — the
  remote side always remains in snapshot history.
- **Edits beat deletes** in both directions — a deletion is easy to redo, an edit is not.
- **A keystroke can start a sync.** R2DO Sync claims no key of its own — plugins that do
  collide with yours — so **Sync hotkey** (under **When it syncs**, desktop only) shows what
  "Sync now" is bound to and offers `⇧⌘S` (`Ctrl+Shift+S` off macOS) in one click, but only
  when nothing else uses it. Otherwise **Choose** opens Obsidian's Hotkeys page filtered to
  this plugin, where every R2DO Sync action — preview, history, conflict review — can take a
  key too.
- **Every pass says what it moved.** "3 files, +35 lines" going out, "1 file, -7 lines"
  coming in — a net line count, so five lines replaced by five others reads as 0 and the file
  count is what shows the work. Binary files have no count. Turning on **List the changed
  files in the notice** names them individually with the snapshot id.
- **A file you edit mid-sync does not fail the sync.** The pass notices the file no longer
  matches what it was about to publish, rescans, and publishes what you actually have. Only a
  file changing continuously across several rescans gives up, and then nothing is published.
- **Mass-change guard.** A pull that would delete more than half of this device's files
  (**Ask before large changes (%)** in settings) stops and asks: apply remote, keep local,
  or decide later. Unattended syncs never decide for you; they park and wait.
- **First sync asks once.** Before a device's very first pass, R2DO Sync says plainly that
  the pass reconciles two collections of real files and asks you to confirm you have a copy
  of the vault. Answered once per device; until it is answered the status reads
  `CONFIRM FIRST SYNC` rather than pretending to be up to date.
- **History and restore** are in the plugin: **Preview sync** shows what a sync would
  change without changing anything, **Snapshot history** browses past snapshots and
  restores a file or the whole vault, and **Sync log** exports recent passes to a note.
- **Forcing a direction, when one side is simply wrong.** Two actions under Safety skip the
  merge. **Pull remote over local** makes this vault match the current remote snapshot;
  changes this device never published are kept as `.conflict-…` copies, so nothing you
  authored is destroyed. **Push local over remote** publishes this device's files as the new
  snapshot without merging what other devices added, and never touches local files. Both
  first show the file counts and names they will touch, then require a typed confirmation
  (`PULL REMOTE` / `PUSH LOCAL`). The snapshot being replaced stays in **Snapshot history**.
- **Selective and one-way policies.** **Only sync matching paths** is an optional allow-list
  of globs. **Pull-only** applies remote changes but never commits; **Push-only (backup)**
  never writes local files, and preserves a racing remote edit as a conflict entry in the
  new snapshot. Paths outside the allow-list remain carried remotely rather than deleted.
- `.obsidian/**` is local by default. **Sync Obsidian configuration directory** requires a
  typed `SYNC CONFIG` confirmation; even then R2DO Sync's current and legacy credential
  folders plus every `workspace*.json` remain hard-skipped. Explicit excludes still win.
- Changing the encryption mode or key is a separate `REKEY` operation. It authenticates
  and transforms the complete remote snapshot in one compare-and-set commit; ordinary
  sync halts on a key/mode mismatch instead of mixing ciphertext and plaintext.

### Tuning (Advanced settings)

The defaults suit a typical vault; the **Advanced** section exposes the knobs that used to
be fixed in code, each stating what it trades:

| Setting | Default | What it costs |
|---|---|---|
| **Parallel lanes** | 4 | Files read, encrypted, uploaded and downloaded at once. Higher finishes a large vault sooner but uses more memory and can overwhelm a phone or a slow link; 1 is the old one-at-a-time behaviour. |
| **Sync log length** | 50 | Passes kept for troubleshooting. They live in the plugin's data file. |
| **Report folder** | vault root | Where **Export** writes its note. Created if missing; it syncs like any other note unless excluded. |
| **Snapshots listed in history** | 40 | How far back the history browser walks. Each one is a request. |
| **Automatic retries** | 3 | Retries after a failed pass (1s, 4s, 15s, 1m, 5m). A *halted* sync is never retried — it needs a person. |
| **Sync settings between devices** | on | Shares the vault-wide settings above through the server, encrypted like your notes. The most recent change on any device wins. |

The three toggles in **Notices** decide what a finished pass says: **Notice when a sync
finishes** (on — a summary of files moved each way and the net line change, and the only
confirmation a phone gets), **Only notice syncs that changed something** (off — a sync you
start yourself still always answers), and **List the changed files in the notice** (off —
each file by name with its line change and the snapshot id).

Numbers are stored when you leave the field or press Enter, not while you type: a value the
setting cannot use is refused out loud and the field goes back to what is stored, rather than
saving each digit on the way to the one you meant. Both glob fields show how many of the
files Obsidian has indexed the current lists keep, updated as you type.

Vault-wide settings — excludes, the safety threshold, debounce and sync intervals, the
allow-list, sync direction, log/history/retry knobs, the report folder, notices, and the
public vault salt — sync between devices: change one anywhere and every device picks it up
before its next pass. Config-directory opt-in deliberately stays per-device because each
device must confirm that its own plugin settings may contain secrets. Credentials and these
other settings also stay per-device:
credentials (a device needs them *before* it can sync, and they are the same for every
device anyway), **Device name** (its whole point is to differ), and **Parallel lanes** (a
desktop on fibre and a phone on mobile data want different values).

## Restore outside Obsidian

`scripts/restore.mjs` decrypts any snapshot to a directory using the master key, with no
Obsidian and no plugin involved:

```bash
node scripts/restore.mjs --out ./restored              # current head
node scripts/restore.mjs --out ./restored --head <manifest-id>
node scripts/restore.mjs --out ./restored --passphrase --salt <public-vault-salt>
```

It prompts for the access token and master key (or reads `ACCESS_TOKEN` / `MASTER_KEY`), so
neither lands in your shell history. Passphrase mode reads `VAULT_PASSPHRASE` or prompts
without echo; its non-secret salt can come from `--salt` or `VAULT_SALT`. Never put the
passphrase itself after `--passphrase`.

It re-implements the crypto independently of the plugin on purpose, and a test keeps the
two byte-compatible — so a bug in the plugin cannot make your backups unreadable.

## Limits

- 100 MiB per file (Workers request-body limit); larger files are skipped and reported.
- 100,000 files per snapshot.
- Merge granularity is a line; two edits inside one line conflict.
- Nightly garbage collection (04:00 UTC) keeps the last 50 snapshots **or** 30 days of
  them, whichever reaches further back, plus every blob those snapshots reference.
- One vault per deployment.

## Development

```bash
# All commands are run from the repository root.
npm --prefix worker install && npm --prefix plugin install

npm --prefix worker test             # 84 tests, real workerd via vitest-pool-workers
npm --prefix plugin test             # 585 tests, incl. rendered settings-tab/modal coverage
node --test scripts/*.test.mjs       # 42 tests: deploy/setup/release/token helpers

npm --prefix plugin run build        # -> plugin/dist/{main.js,manifest.json,styles.css}
node scripts/release-validate.mjs 0.1.8   # release layout check; must run from the root
```

`worker/wrangler.jsonc` is the single source of deployment metadata for both deploy paths.
A release is cut by pushing a tag equal to the `manifest.json` version:
`.github/workflows/release.yml` runs the suites, builds, attests the assets and publishes
`main.js`, `manifest.json` and `styles.css` on the GitHub release.
