# R2DO Sync

Two-way Obsidian vault sync on **your own** Cloudflare account — no third-party service, no
subscription, end-to-end encrypted with a master key that never leaves your devices. The
free plan is enough for a text vault.

Optionally, it also lets **Claude, Codex or any other MCP client read and write your notes**
without Obsidian running anywhere. That part is off unless you ask for it — see
[Connect an AI assistant](#connect-an-ai-assistant).

## What you need

A Cloudflare account (free plan), Node.js 20+, Obsidian, 5 minutes.

## Setup

```bash
git clone https://github.com/pc418/cloudflare-r2do-sync.git && cd cloudflare-r2do-sync
npm --prefix worker install && npm --prefix plugin install
node scripts/setup.mjs
```

Log in first, if you have not already, with the wrangler this repo pins —
`node worker/node_modules/wrangler/bin/wrangler.js login` (same on every OS; setup uses only
that copy and never logs you in or out). Setup prints **which account** it is about to
deploy to and waits for you to confirm, then creates everything it needs and issues your
access token. Every step is idempotent — re-running after a failure resumes. The admin
credential lives in gitignored `.env`, managed for you.

```
════════════════════════════════════════════════════════════════════
  PASTE THESE INTO OBSIDIAN
════════════════════════════════════════════════════════════════════

  Server URL   https://obsidian-log-sync.<your-subdomain>.workers.dev
  Access token <64 hex characters>
  ...
```

Then install the plugin (or, once the community listing is live, install **R2DO Sync** from
Settings → Community plugins — the Worker is yours to deploy either way):

```bash
cd plugin && node build.mjs && cd ..
node scripts/install-plugin.mjs "/path/to/Your Vault"
```

1. Obsidian → Settings → Community plugins → enable **R2DO Sync**.
2. The **Set up sync** panel takes the printed **Server URL** and **Access token**, plus a
   **Device name** (conflict copies are named after it). It checks them against the server
   before saving anything, and tells you whether the vault it found is new or already has
   snapshots.
3. R2DO Sync generates a random vault master key and opens the required backup window. Copy
   the key into your password manager and press **I saved it** — sync stays disabled until
   you do. Then press **Sync now**.

The random key is recommended. **Set from passphrase** derives the same key on any device,
but a weak passphrase is open to offline guessing.

### Adding another device

On the configured device, open **Set up another device**: **Show QR** for a phone (the code
is an `obsidian://` link the camera opens directly) or **Show setup link** for anything
else. The link is shown as selectable text — copy it yourself and paste it into the new
device with **Apply a setup link**. Nothing is typed by hand, and the plugin never reads or
writes your clipboard, so it asks for no clipboard permission.

**Do this before the new device's first sync.** URL and token typed in manually cannot join
an encrypted vault — neither carries the master key — so the device stops and offers the
paste box instead. That halt is the safety net working.

A new device that already holds a copy of the vault is fine: identical files match by
content, the rest merges, and anything ambiguous keeps both copies. Nothing local is
deleted on a first sync.

### On a phone

Before the community listing appears, let a computer do the install once: set the vault up
on a desktop, zip the whole vault folder, and unzip it inside Obsidian's folder on the
phone — the hidden `.obsidian` folder travels inside the zip even on iOS, carrying plugin,
settings and keys. Just change **Device name** afterwards. (Android can instead copy the
three `plugin/dist/` files into `YourVault/.obsidian/plugins/cloudflare-rdo-sync/` and set
up by QR as usual.)

Once running, the **ribbon icon** is the sync button. By default a pass that moved files says
so and a pass that found nothing stays quiet; **What sync announces** turns that up to every
pass or down to nothing. If you want a tap acknowledged even when there was nothing to do, that
is **Say when a sync starts**. Returning to the app counts as startup — if the last pass is
older than **Sync on returning to the app** (15 minutes by default, 0 to never), a sync runs.
Returning fires more often than it sounds — a screen unlock counts — so raise that number, or
set it to 0, if the phone syncs more than you want.

To sync without any pop-ups at all, set **What sync announces** to **Silent** — but turn on
**Show the status bar on mobile** first. Obsidian hides the status bar on phones, so without it
a silent device has nothing on screen to say a sync has started failing.

## Connect an AI assistant

An optional **second Worker** lets an AI assistant read — and, if you allow it, write — this
vault over [MCP](https://modelcontextprotocol.io), with no Obsidian running anywhere. Ask it
what you wrote about something last month, have it file a note while you are away from your
desk, let it keep a log for you. It is off by default and entirely skippable: nothing in the
plugin depends on it.

**Understand the trade before you deploy it.** This Worker holds your vault master key, which
is the one secret the sync Worker never sees. It decrypts your notes in order to answer, so
whatever it reads reaches your model provider as plaintext. The sync Worker's "the server
cannot read your notes" property does not extend to this one — that is the point of it being a
separate thing you have to ask for. Deleting it and revoking its token ends it.

### Deploy it

```bash
# Read-only: it can answer questions about your vault, and change nothing.
node scripts/deploy.mjs --vault my-vault --agent

# Read and write: adds capture and editing.
node scripts/deploy.mjs --vault my-vault --agent --agent-writable
```

`--agent` needs `--vault`, and refuses to stand an agent over your default deployment — so
your main vault's master key cannot reach a Worker by way of a flag on a routine deploy. The
confirmation screen names the new Worker before anything is created.

When it finishes, everything a client needs is in one file at the repository root:

```
DEPLOY-CREDENTIALS.my-vault.txt      (mode 0600, gitignored)
```

It holds the URL ending in `/mcp`, the header name, and the complete header value, ready to
paste. The terminal shows only the URL and a short fingerprint — enough to tell one deploy
from another, useless for signing in — so the credential itself never sits in your scroll-back
or in a transcript.

**Read it, store the values somewhere safe, then delete the file.** It says so itself, and the
last section explains what deleting it changes.

### Keeping some folders out of its reach

```bash
node scripts/deploy-agent.mjs --vault my-vault --deny "Private/**, Keys/**"
```

Anything matching is invisible to every tool — it cannot be listed, searched, read, written or
deleted — and the rule is set where the Worker is deployed, so nothing you sync can widen it.
That is deliberately a different control from the vault's own excludes, which are a synced
setting any of your devices can edit, and which also stop the folder reaching your other
devices. Use `--deny` when you want a folder on all your devices but not in front of a model.

Two honest limits. It governs what the *agent* may decrypt, not what your vault has stored:
those notes stay in snapshots already taken, exactly as excluded ones do, and only a re-root
removes them. And a glob that matches nothing denies nothing — check the deploy's `deny list:
N glob(s)` line, then try to read something under the folder and confirm it refuses.

### Standing one over your default deployment

The default vault is deliberately harder to reach, because its master key is the one worth
most:

```bash
node scripts/deploy-agent.mjs --live --deny "Private/**"
```

`--live` is the only path there, and it **requires `--deny`**. That is not a formality: this
is the deployment that puts your main vault's key into a Worker secret, and naming what stays
out of reach is meant to be a decision you make rather than one you skip.

### Claude (web and desktop)

Settings → **Connectors** → **Add custom connector**:

Every value below is in `DEPLOY-CREDENTIALS.<vault>.txt`, in this order, ready to paste:

| | |
|---|---|
| **URL** | the one ending in `/mcp` |
| **Authentication** | **None** |
| **Header name** | `Authorization` |
| **Header value** | `Bearer …` — copy the whole line, including the word `Bearer` |

Check for a **Request headers** section in that dialog *first*. It is a gated beta, and if
your account does not have it there is currently no other supported way in — the deploy is
wasted effort until it appears.

Three things that each cost an hour if missed. The header value is sent exactly as typed, so
it must include the word `Bearer` and the space. The URL must end in `/mcp`, never `/sse`.
And **authentication settings cannot be changed once the connector exists** — which is why a
redeploy never reissues the header value on its own. If you do run `--rotate-bearer`, remove
the connector and add it again.

### Claude Code

```bash
claude mcp add --transport http obsidian https://<your-agent>.workers.dev/mcp \
  --header "Authorization: Bearer <the value from DEPLOY-CREDENTIALS.<vault>.txt>"

claude mcp list          # confirm it connected
```

Add `-s user` to make it available in every project rather than just this one. Avoid
`-s project`: that writes the header, credential and all, into a `.mcp.json` in the repository.
Claude Code loads MCP servers at startup, so restart the session before the tools appear.

### Codex

```bash
codex mcp add obsidian --url https://<your-agent>.workers.dev/mcp \
  --bearer-token-env-var OBSIDIAN_MCP_TOKEN

codex mcp list
```

Codex reads the token from that environment variable each run, so export it in your shell
profile rather than putting the secret in a config file:

```bash
export OBSIDIAN_MCP_TOKEN=<token>      # no "Bearer " prefix here — Codex adds it
```

### Any other MCP client

Anything that speaks **streamable HTTP** and can send a custom header will work. Point it at
the `/mcp` URL, send `Authorization: Bearer <token>`, and that is the whole configuration —
there is no OAuth, no session to establish, and nothing to install locally.

### What it can do

Read-only gives it `search`, `read`, `list` and `recent`. `--agent-writable` mints a second,
separately revocable token and adds `append`, `edit`, `write`, `delete` and `move`.

The write tools behave like a file system: `write` replaces a note outright and `delete`
removes one, neither asks for confirmation, and folders are created and left behind
automatically as notes come and go. **Your undo is snapshot history**, so the retention window
is what a mistake costs, and getting a note back is done from the plugin — the assistant
cannot do it for you. `move` is the one exception to the plain-`rm` reading: it refuses to
land on a path that already exists rather than replacing a different note.

**What it will never touch.** Your vault's own exclude and only-paths rules bind it on reads
as well as writes, and the credential folders are filtered out of what it can read at all.
Everything it writes syncs to your devices like any other device's changes, mass-deletion
guard included.

### Teaching it your vault

Put a note called **`AGENTS.md`** at the root of your vault:

```markdown
- Daily notes live in `Daily/YYYY-MM-DD.md`.
- Read `Inbox.md` first for what I am working on.
- When I say *log X*, append X under `## Log` in today's daily note.
```

That is served to the assistant when a conversation starts, so you can ask for things in
fewer words. It is an ordinary note: edit it on any device and it syncs, and history versions
it like anything else. On a writable deployment the assistant can edit it itself, so "remember
that my daily notes live under Daily/" is one request away — with new text taking effect in
your *next* conversation, not the current one.

Two limits worth knowing. It is read through the same rules as every other note, so an
`AGENTS.md` your vault excludes is invisible. And it is advice to the model, never
configuration — it cannot un-hide a path, widen what the assistant may read, or change what a
tool does.

Some clients do not pass server instructions to the model at all (Claude Code's deferred tool
loading is one). The `list` and `search` tools mention `AGENTS.md` in their own descriptions to
cover that, so the assistant finds the note the first time it looks around your vault. If it
still seems not to know your conventions, ask it in the chat what its instructions for this
vault say — an empty answer means that client dropped them, and "read `AGENTS.md` first" is a
one-line fix for that conversation.

### Updating and reissuing credentials

Redeploying is safe and boring. Code and settings are replaced; **nothing is reissued unless
you ask**, so a client that works keeps working:

```bash
node scripts/deploy-agent.mjs --vault my-vault --writable     # new code, same credentials
```

| To change | Pass | What it costs |
|---|---|---|
| the header value a client sends | `--rotate-bearer` | connector auth cannot be edited after it is created, so you must remove and re-add the connector |
| the agent's own vault tokens | `--rotate-tokens` | nothing — no client ever sees these; the pair it replaces is revoked once the new one answers |
| what it may not touch | `--deny "…"` | takes effect immediately; `--deny ""` clears it |
| read-only ⇄ read-write | add or drop `--writable` | dropping it deletes the write credential outright, not just the tool list |

A failed deploy revokes anything it created before it stops, and a successful one retires the
credentials it replaced only after the new deployment answers — so you are never left with a
live credential nothing names, or a working agent whose credential was withdrawn under it.

One thing follows from the handover file being the handover: **while it exists, a redeploy
keeps the admin token it names**, because otherwise the file would quietly stop being true.
Once you have stored the values and deleted it, the next deploy issues a fresh one and writes
a new file. The MCP header value is the exception and is never reissued on its own — only
`--rotate-bearer` changes it.

### Turning it off

Delete the agent Worker in the Cloudflare dashboard, and revoke its tokens with
`node scripts/access-token.mjs --vault my-vault --list` and `--revoke <id>`. Your vault and
every device are unaffected — the agent was only ever another device as far as they are
concerned.

If you want its **search index** gone too, drop it first with an authenticated
`DELETE <agent-url>/admin/index`. It holds note text in the Worker's own storage, and deleting
a Worker's code is not the same operation as deleting its stored data.

## Everyday use

- **Conflicts keep both sides, then let you choose.** The remote copy lands beside yours as
  `note.conflict-<device>-<yymmdd-HHmm>.md`; nothing is overwritten in place. A window shows
  the line-by-line difference with four choices: keep this device's, keep the other's, keep
  both files, or **combine into one** with the disagreements marked for you to edit.
  Background syncs park the copy and wait; **Review and resolve conflicts** reopens the
  latest batch any time.
- **Optional: let conflicts overwrite.** *Newest wins* or *largest wins* picks the same
  winner on every device (the loser stays in snapshot history). Enabling either asks for a
  second confirmation.
- **Edits beat deletes** in both directions — a deletion is easy to redo, an edit is not.
- **Every pass says what it moved** — "3 files, +35 lines" out, "1 file, -7 lines" in.
- **A file you edit mid-sync does not fail the sync.** The pass rescans and publishes what
  you actually have; only a file changing continuously across several rescans gives up.
- **Mass-change guard.** A pull that would delete more than half of this device's files
  (threshold in settings) stops and asks. Unattended syncs never decide for you.
- **First sync asks once** per device to confirm you have a copy of the vault. A vault with
  nothing in it yet is downloaded rather than published, so a fresh install cannot overwrite
  your notes with an empty one.
- **Preview, history, log.** **Preview sync** shows what a pass would change without changing
  anything; **Snapshot history** browses and restores past snapshots; **Sync log** exports
  recent passes to a note. **Sync hotkey** binds "Sync now" (`⇧⌘S` offered when free).
- **Remove empty folders.** Only files sync, so a folder moved on one device leaves its empty
  shape behind on the others. A pass clears the folders its own deletions emptied; this button
  finds any left over, lists them, and removes them only once you agree. A folder holding any
  file — including one this device does not sync — is never touched.
- **History by day, week, or every sync**, with an optional date range. A grouped row is one
  calendar day (or week): its newest snapshot, compared against the newest of the day before,
  and labelled with how many syncs that covers. Grouping is what makes the window reach months
  instead of days on a vault that syncs often.
- **Forcing a direction**, when one side is simply wrong: **Pull remote over local** keeps
  unpublished local changes as `.conflict-…` copies; **Push local over remote** publishes
  without merging. Both preview what they will touch and require a typed confirmation, and
  the replaced snapshot stays in history.
- **Selective and one-way policies.** An optional allow-list of globs; **Pull-only** never
  commits; **Push-only (backup)** never writes local files. Paths outside the allow-list are
  left alone remotely, not deleted.
- Your config folder is local by default; syncing it requires a typed `SYNC CONFIG`
  confirmation, and the credential folders and `workspace*.json` stay excluded even then.
- Changing the encryption mode or key is a separate `REKEY` operation; ordinary sync stops
  until it is resolved.

### Tuning

| Setting | Default | Trade |
|---|---|---|
| **Parallel lanes** | 4 | Files processed at once; higher is faster but heavier on a phone or slow link |
| **Sync log length** | 50 | Passes kept for troubleshooting |
| **Rows listed in history** | 40 | Each one is a request. A row is one sync, one day or one week, whichever the history window is grouped by |
| **Automatic retries** | 3 | Backoff after a failed pass; a *halted* sync is never retried — it needs a person |
| **What sync announces** | Activity | One ordered choice: **All** (every pass), **Activity** (only passes that changed something), **Problems** (conflicts and errors), **Silent** (nothing). State still shows in the status bar and the sync log at every level — only the pop-ups stop |
| **Say when a sync starts** | off | The "syncing…" pop-up while a sync *you* started runs. Separate from the level above because it answers your tap, so it works at every level |
| **Label** | `Cloudflare R2DO Sync` | The name in front of every notice, with its own on/off |
| **List the changed files** | off | Names each file that moved instead of counts alone, and is what puts the snapshot id in the notice |
| **Show the status bar on mobile** | off | Forces Obsidian's hidden mobile status bar open, so sync state is readable without notices |
| **Sync settings between devices** | on | Shares vault-wide settings through the server, encrypted like notes; most recent change wins |
| **Snapshot retention** (server) | 90 days / 500 snapshots | Not a plugin setting — see [Limits](#limits) |

Vault-wide settings (excludes, thresholds, intervals, direction…) sync between devices.
Credentials, **Device name**, **Parallel lanes**, everything under **Notices** and
config-folder consent deliberately stay per-device — "quiet on my phone, everything on my
desktop" is the ordinary case, and a shared switch cannot express it.

---

# Reference

Everything below is how it works rather than how to use it.

## Built like version control

Most sync plugins compare timestamps and sizes and guess: newer wins, one side is silently
discarded, deletions are inferred rather than observed, and two devices uploading at once
interleave. R2DO Sync keeps a commit log instead:

- **Every sync publishes a commit** — an encrypted snapshot of the whole vault, naming every
  file by the hash of its content, plus the id of the snapshot it grew from.
- **One authority orders the commits.** A Durable Object accepts a commit only if its parent
  is still the current head. When two devices publish at once, exactly one wins; the other
  pulls, merges, and retries. History is linear by construction.
- **Pull → merge → commit, never the other way.** Before publishing, a device absorbs the
  current head and three-way merges (diff3) against the snapshot both sides actually share.
  Two devices appending to the same note both keep their lines, ordered by text.
- **Decisions come from content hashes, never clocks.** A bad timestamp cannot fake a change
  or hide one; deletions are stated by the snapshot.
- **Content addressing keeps it cheap.** Each unique (encrypted) content is stored once; a
  commit uploads only what changed.
- **History is real.** Any snapshot restores — one file or the whole vault — and nightly
  garbage collection trims old ones on your schedule.

The **Worker** is the API, **R2** stores the encrypted blobs and manifests, and the
**Durable Object** serializes commits. All of it runs in your account; the server sees only
ciphertext and an opaque path map — never a filename or a key.

**Continuity check.** Before merging a snapshot it has not seen, a device traces it back to
the one it last synced — usually the snapshot's own parent, costing nothing. If the trail
runs out (history rebuilt, or the device away longer than the server keeps history), the pass
stops and asks instead of merging a history it cannot place. On an encrypted vault every link
the check follows is authenticated with the vault key, so the trail cannot be forged by
whoever serves it.

Snapshot ids are shown as their last 7 characters everywhere on screen. They are ULIDs, so
the first ten characters are the timestamp and the end is the part that identifies the
snapshot. The exported **Sync log** keeps all 26, because that is the id the server API takes.

## Security model

- **Encryption happens on the device.** Contents and paths are AES-256-GCM encrypted with
  keys derived (HKDF) from one 256-bit master key. The server sees blob hashes and an
  encrypted path map; blob names are `sha256(ciphertext)`, so it can verify integrity
  without reading anything.
- **The master key never leaves your devices** — not in `.env`, not on the server, not
  recoverable by anyone including you. Keep a copy somewhere safe.
- A passphrase-derived key uses PBKDF2-SHA256 at 600,000 iterations over a public per-vault
  salt shared through setup links; a conflicting salt is rejected rather than silently
  deriving a different key. Only the derived key is stored.
- This plugin's own settings folder and `workspace*.json` are never synced — `data.json`
  holds this device's token and master key in plaintext.
- **Installed plugins, themes and CSS snippets are never synced**, even with config-folder
  sync on: Obsidian executes those, and `plugins/<id>/data.json` is where your *other*
  plugins keep credentials. Obsidian's own settings files still sync.
- **What the server can still tell:** file count, rough sizes, sync times, device names, and
  that two paths hold identical content (that is what deduplication is). Not contents, not paths.
- **Other software on your device is trusted.** The key and token sit in the plugin's
  `data.json` in plaintext; "encrypted" means the *server* cannot read your notes, not a
  sandbox on your own machine.
- **Setup links and QR codes contain the key.** Treat one like the key itself.
- **The optional agent Worker is the deliberate exception.** It holds the master key and
  decrypts notes to answer, so everything it reads reaches your model provider in the clear.
  Nothing else in this project does that.
- **Snapshot history is not a backup.** It protects against your own mistakes, not against
  losing the account, bucket, or key. Keep an independent export: `scripts/restore.mjs`
  decrypts a snapshot without the plugin.
- **Your data stays your responsibility.** There is no operator who can read your notes back
  or restore them for you. Provided as-is under the PolyForm Small Business 1.0.0 license,
  without warranty.

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
syncing until they get the new one.

A token can also carry less than full authority — without the `reroot` scope (rebuilding
remote history is the only action that makes remote content stop existing) or with an expiry:

```bash
curl -X POST "$WORKER_URL/api/tokens" -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"phone","scopes":["sync"],"expiresAt":"2027-01-01T00:00:00Z"}'
```

`scopes: ["read"]` is weaker still: it reads the head, the snapshot chain, manifests, blobs
and shared settings, and is refused — 403, without touching the vault — on every route that
changes anything, uploads included. It is what a read-only agent deployment is given.
Ordinary devices need `sync`, which covers reading too, so existing tokens are unaffected.

## Your Cloudflare deployment

The plugin is **R2DO Sync**, but the Cloudflare resources keep this project's original name,
`obsidian-log-sync`. That is what to look for in the dashboard:

| Cloudflare | Name | Where |
| --- | --- | --- |
| Worker | `obsidian-log-sync` | Workers & Pages — serves `obsidian-log-sync.<your-subdomain>.workers.dev` |
| R2 bucket | `obsidian-log-sync` | R2 — every snapshot and blob your vault has |
| Durable Object | `VaultLock` | the Worker's bindings — holds the authoritative head |

All three come from `worker/wrangler.jsonc`. Renaming them is a migration, not an edit — a
new Worker name means a new, empty Durable Object, and R2 buckets cannot be renamed at all —
so `scripts/deploy.mjs` refuses to deploy a rename it would fork. The same file's `vars` hold
snapshot retention (`GC_KEEP_DAYS` / `GC_KEEP_COUNT`); every deploy restates them, so editing
the file and redeploying is how they change.

### A second, separate vault

One deployment serves exactly one vault (one Durable Object head), so a second vault is a
second deployment, not a second bucket behind the same Worker:

```
node scripts/setup.mjs --token --vault notes-2      # or VAULT_NAME=notes-2
```

The name becomes the Worker script and R2 bucket name, and the Durable Object namespace
follows the script. Nothing is shared with your first vault except the account. The new
vault's URL and admin credential are written to gitignored **`.env.<name>`**, never `.env`;
pass the same `--vault` to every later command for that vault:

```
node scripts/deploy.mjs --vault notes-2            # redeploy after a Worker change
node scripts/access-token.mjs --vault notes-2      # re-issue the access token
node scripts/access-token.mjs --vault notes-2 --list
```

Without the flag every script means your default deployment — and *succeeds* there rather
than failing usefully. The resolved vault is printed before anything is created.

A name is refused when it is your default deployment's own name, an unrelated existing
bucket, anything containing `sandbox` (that marker belongs to throwaway test deployments
that `scripts/sandbox.mjs --destroy --all` deletes), or a name already belonging to a Worker
on your account — deploying would replace that Worker. `--adopt-worker` is the deliberate
way past, and only ever right for a vault of your own whose `.env.<name>` you lost.

Use it with a **different** Obsidian vault: pointing an existing device at a new deployment
copies nothing, it just changes which (empty) remote that device syncs with. REST path only,
because wrangler deploys whatever `worker/wrangler.jsonc` names.

Nothing changes in the plugin, and there is no extra setting. Each Obsidian vault keeps its
own plugin settings, so you set the second one up exactly like the first. The vault name is
an operator-side label and never reaches the plugin, which only ever sees a URL.

### Deploying without wrangler

For CI, or a machine whose wrangler is signed in to a different account: copy `.env.example`
to `.env`, fill in `CLOUDFLARE_TOKEN` (scopes: *Workers Scripts:Edit*, *Workers R2
Storage:Edit*) and `CLOUDFLARE_ACCOUNT_ID`, then `node scripts/setup.mjs --token`. With both
present this path is chosen automatically; the script never silently switches accounts.

## Restore outside Obsidian

`scripts/restore.mjs` decrypts any snapshot to a plain directory — no Obsidian, no plugin:

```bash
node scripts/restore.mjs --out ./restored              # current head
node scripts/restore.mjs --out ./restored --head <manifest-id>
node scripts/restore.mjs --out ./restored --passphrase --salt <public-vault-salt>
```

It prompts for the access token and master key (or reads `ACCESS_TOKEN` / `MASTER_KEY`), so
neither lands in shell history. It re-implements the crypto independently on purpose, and a
test keeps the two byte-compatible — a bug in the plugin cannot make your backups unreadable.

## Limits

- 100 MiB per file (Workers request-body limit); larger files are skipped and reported.
- 100,000 files per snapshot.
- Merge granularity is a line; two edits inside one line conflict.
- Nightly garbage collection (04:00 UTC) keeps the last 500 snapshots **or** 90 days of
  them, whichever reaches further back, plus every blob they reference —
  `GC_KEEP_COUNT` / `GC_KEEP_DAYS` in `worker/wrangler.jsonc`; edit them and redeploy.
  Retained snapshots restate the whole path map, so this — not file content — is usually
  what a vault's storage is spent on. Shrinking it also shortens how long a device can be
  offline and still merge cleanly against a shared base.
- One vault per deployment.

## Development

```bash
# All commands are run from the repository root.
npm --prefix worker install && npm --prefix plugin install

npm --prefix worker test             # real workerd via vitest-pool-workers
npm --prefix plugin test             # incl. rendered settings-tab/modal coverage
npm --prefix agent test              # the optional MCP Worker
node --test scripts/*.test.mjs       # deploy/setup/release/token helpers
npm --prefix plugin run lint         # typed lint; the baseline is zero, so any finding is new
npm --prefix worker run lint
npm --prefix agent run lint

# Optional: the same plugin driven against a REAL deployed Worker, with real files on disk.
# Needs a throwaway sandbox on a Cloudflare account that is not the one holding your vault.
node scripts/sandbox.mjs             # deploy one; --suffix <group> for an isolated second
npm --prefix plugin run test:live    # skips entirely when no sandbox is deployed
node scripts/sandbox.mjs --destroy --all

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

Your privacy, now verifiable. How much is it worth to you?

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/F1F11WRQDT)
