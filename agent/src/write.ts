/**
 * The commit primitive: a scoped mini-pass, not a sync pass.
 *
 * The agent holds no replica, so it needs none of the engine's audit, journal, folder pruning
 * or three-way merge against a stale base. Its base is always the head it just absorbed, which
 * is the standing "never publish before absorbing the current remote head" invariant in its
 * degenerate form. A batch of ops becomes exactly one snapshot.
 */
import { StaleHeadError } from "../../plugin/src/api";
import { sha256Hex } from "../../plugin/src/hash";
import { countLines } from "../../plugin/src/lines";
import { alwaysSkip, pathError, selfDirs } from "../../plugin/src/paths";
import { blobKey, buildManifest, type FileEntry } from "../../plugin/src/types";
import { VaultError, type VaultView } from "./vault";
import { ulid } from "./ulid";

export type WriteOp =
  | { kind: "append"; path: string; text: string }
  | { kind: "edit"; path: string; oldText: string; newText: string; replaceAll?: boolean }
  | { kind: "write"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "move"; from: string; to: string };

/**
 * Every vault path an op touches — both ends of a `move`.
 *
 * The refusal and scope gates iterate this rather than a single `path`, because a `move` whose
 * destination nobody checked is a way to write outside the policy using a source inside it.
 */
export function opPaths(op: WriteOp): readonly string[] {
  return op.kind === "move" ? [op.from, op.to] : [op.path];
}

export interface WriteOutcome {
  head: string;
  /** One line per op, in the order they were applied — what the model is told happened. */
  applied: string[];
}

/** Attempts at the CAS loop. A real device racing the agent resolves within one or two. */
const CAS_ATTEMPTS = 4;

/**
 * Refuses a path the vault itself would never sync, before anything is uploaded.
 *
 * `selfDirs` is the sharp one: that folder holds this vault's access token and master key.
 * Everything else is the standing hard-skip set — plugin state, executable config, VCS junk.
 * A refusal is reported to the model in words; it is never a silent drop, because a capture
 * tool that quietly discards a note is worse than one that fails.
 */
export function refuseWrite(path: string, configDir: string): string | null {
  const shape = pathError(path);
  if (shape !== null) return shape;
  for (const dir of selfDirs(configDir)) {
    if (path === dir || path.startsWith(`${dir}/`)) {
      return `"${path}" is inside this plugin's own folder, which holds device credentials`;
    }
  }
  if (alwaysSkip(path, configDir)) return `"${path}" is not a path this vault syncs`;
  return null;
}

/**
 * Refuses a batch whose **result** holds one path as both a note and a folder.
 *
 * A manifest is a flat path map, so folders have no entries and nothing in the format stops a
 * commit holding both `Projects` and `Projects/Roadmap.md`. **No filesystem can materialize
 * that**, and a device pulling it fails in `#ensureFolder` ("parent path is not a folder") —
 * so the agent would have published a snapshot that wedges every device's next sync. The
 * server cannot catch it either: on an encrypted vault it never sees a path.
 *
 * Judged **once, on the finished map**, never per operation. A per-op check rejected
 * `write Projects` followed by `delete Projects/Roadmap.md` — a batch whose result is perfectly
 * materializable — purely because of the order the two arrived in. What is committed is the
 * only thing that has to be legal.
 *
 * Only paths the batch *introduced* are checked, so a clash already sitting in the vault from
 * some other source does not start failing every unrelated agent write.
 *
 * Found by adversarial review on `move`; it was never specific to `move`. `write` and `append`
 * reach it with one mistyped path, which is why this guards the batch rather than one case.
 */
function assertMaterializable(
  touched: Iterable<string>,
  files: Record<string, FileEntry>,
  visible: Record<string, FileEntry>
): void {
  // Folded, because a snapshot has to materialize on the devices that will pull it, and the
  // default filesystems on macOS and Windows are case-insensitive. A note `Projects` and a
  // note `projects/Roadmap.md` are two distinct keys here and one impossible directory there.
  const fold = (p: string): string => p.normalize("NFC").toLowerCase();
  const byFolded = new Map<string, string>();
  for (const key of Object.keys(files)) byFolded.set(fold(key), key);

  for (const path of touched) {
    if (!Object.hasOwn(files, path)) continue; // introduced, then removed again by a later op
    const folded = fold(path);

    // An ancestor of this path that is itself a note: `Notes` exists, and we wrote `Notes/a.md`.
    for (let i = folded.indexOf("/"); i !== -1; i = folded.indexOf("/", i + 1)) {
      const ancestor = byFolded.get(folded.slice(0, i));
      if (ancestor !== undefined) {
        throw new VaultError(
          `"${ancestor}" is a note, so "${path}" cannot live inside it. Pick another path.`
        );
      }
    }

    // Or this path is itself a folder someone still has files in.
    for (const [otherFolded, other] of byFolded) {
      if (!otherFolded.startsWith(`${folded}/`)) continue;
      // Naming the child is the helpful message, but `files` carries excluded entries the
      // agent may not read — and an exclude glob like `Credentials/**` does not match the bare
      // folder, so this refusal is reachable with a hidden child behind it. An error is a read
      // channel: name the child only when the agent could have listed it anyway.
      throw new VaultError(
        Object.hasOwn(visible, other)
          ? `"${path}" is a folder in this vault (it holds "${other}"), so it cannot also be a note. Pick another path.`
          : `"${path}" is a folder in this vault, so it cannot also be a note. Pick another path.`
      );
    }
  }
}

/**
 * A path map with no prototype.
 *
 * Vault paths are caller-chosen strings and `constructor`, `toString` and `valueOf` are all
 * legal ones. On a plain object `files["toString"]` answers with an inherited function, so an
 * existence check finds a note that is not there — and a `move` would carry that function into
 * the manifest. Dropping the prototype makes the whole class of question impossible rather
 * than remembering `Object.hasOwn` at every lookup.
 */
function pathMap(from: Record<string, FileEntry>): Record<string, FileEntry> {
  return Object.assign(Object.create(null) as Record<string, FileEntry>, from);
}

export class VaultWriter {
  readonly #view: VaultView;
  readonly #device: string;
  readonly #configDir: string;

  constructor(opts: { view: VaultView; device: string; configDir?: string }) {
    this.#view = opts.view;
    this.#device = opts.device;
    // Falls back to the view's, never to a literal: two objects disagreeing about which
    // directory holds the credentials is how one of them stops protecting it.
    this.#configDir = opts.configDir ?? opts.view.configDir;
  }

  /**
   * Applies a batch as one snapshot, re-applying from the new head if the CAS is lost.
   *
   * Re-applying rather than retrying the same manifest is the whole point: `edit`'s
   * unique-old-string contract re-checks against whatever the other device just wrote, so it
   * either still matches, or fails loudly instead of clobbering.
   */
  async apply(ops: readonly WriteOp[]): Promise<WriteOutcome> {
    if (ops.length === 0) throw new VaultError("no operations to apply");
    for (const path of ops.flatMap(opPaths)) {
      const refusal = refuseWrite(path, this.#configDir);
      if (refusal !== null) throw new VaultError(refusal);
    }

    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const snapshot = await this.#view.snapshot({ fresh: true });

      // The shared policy, not just the hard skips: a path this vault excludes is one ordinary
      // devices deliberately do not scan, so committing it would report success for a note that
      // never reaches anyone's disk.
      //
      // The snapshot's OWN predicate, not a second `scope()` call. Two reads of the settings
      // document are two policies: hoisted above the loop, a batch that lost its first CAS
      // while the policy changed kept applying a predicate the vault had replaced; read
      // separately inside the loop, a path hidden when `files` was built but permitted an
      // instant later passed the gate while absent from the visible map — which reads as "this
      // note does not exist" and replaced the carried content with nothing. One policy per
      // attempt, and it is the one that built the map. It also saves a subrequest.
      const inScope = snapshot.inScope;
      for (const path of ops.flatMap(opPaths)) {
        if (!inScope(path)) {
          throw new VaultError(
            `"${path}" is outside what this vault syncs (its exclude or only-paths policy), so writing it would publish a note no device would download`
          );
        }
      }

      // The complete map, not `snapshot.files`. Excluded and hard-skipped entries are carried
      // through snapshots deliberately; building from the visible subset would delete every
      // one of them — silently destroying exactly what the vault takes most care to keep.
      //
      // Null-prototype: see `pathMap`.
      const files = pathMap(snapshot.all);
      // A working copy of the visible half, carried alongside so ops chain within a batch —
      // a second append to one path must see the first. Copied, never the snapshot's own
      // object: mutating that would poison the view's cache for every later read.
      const seen = pathMap(snapshot.files);
      const applied: string[] = [];

      for (const op of ops) {
        // Sequential, and reading `files` as it goes, so two ops on one path in the same
        // batch chain instead of racing — the second sees what the first wrote.
        applied.push(await this.#applyOne(op, files, seen));
      }

      // On the finished map, because only what is committed has to be legal.
      assertMaterializable(
        ops.flatMap((op) => (op.kind === "move" ? [op.to] : op.kind === "delete" ? [] : [op.path])),
        files,
        seen
      );

      // Everything the resulting map references, including entries carried untouched from the
      // parent — which is what preserves excluded/skipped carry semantics for free.
      const blobs = [...new Set(Object.values(files).map(blobKey))];

      const manifest = await buildManifest({
        crypto: this.#view.crypto,
        parent: snapshot.head,
        files,
        blobs,
        id: ulid(),
        device: this.#device,
        createdAt: new Date().toISOString(),
      });

      try {
        const head = await this.#view.commit(manifest, snapshot.head);
        return { head, applied };
      } catch (error) {
        // Only a lost CAS is retryable, and its detail is not something the caller can act
        // on — the message says what happened and what to do instead.
        if (!(error instanceof StaleHeadError)) throw error;
      }
    }
    throw new VaultError(
      `another device kept changing this vault while the write was in flight (${CAS_ATTEMPTS} attempts). Nothing was saved — try again.`
    );
  }

  /**
   * Applies one op to the in-progress path map and says what it did.
   *
   * It mutates `files` itself because two of the five ops change no content at all: `delete`
   * removes a key and `move` renames one. Routing those through a "here is the new entry"
   * return would have needed a second shape for "and here is the key to drop", which is how a
   * map mutation ends up expressed in two places.
   */
  async #applyOne(
    op: WriteOp,
    files: Record<string, FileEntry>,
    visible: Record<string, FileEntry>
  ): Promise<string> {
    // Existence is judged against what the agent may SEE, never against the carried map. The
    // scope predicate says the same thing today, but this is structural: the agent cannot
    // remove or read a note that is hidden from it even if a predicate goes stale.
    if (op.kind === "delete") {
      // Deliberately no hash, no confirmation, no percent cap: `rm` semantics, owner's call.
      // Recovery is snapshot history within GC retention, which is what that budget buys.
      if (!Object.hasOwn(visible, op.path)) {
        throw new VaultError(`"${op.path}" does not exist, so there is nothing to delete`);
      }
      delete files[op.path];
      delete visible[op.path];
      return `deleted ${op.path}`;
    }

    if (op.kind === "move") {
      const entry = Object.hasOwn(visible, op.from) ? visible[op.from] : undefined;
      if (entry === undefined) {
        throw new VaultError(`"${op.from}" does not exist, so there is nothing to move`);
      }
      // The one deliberate departure from `rename`'s silent clobber. Overwriting a *different*
      // note by accident is the worst surprise this surface can produce, and an agent that
      // means it can delete the destination first.
      if (Object.hasOwn(files, op.to)) {
        throw new VaultError(
          `"${op.to}" already exists, so moving "${op.from}" onto it would replace a different note. Delete it first if that is what you want.`
        );
      }
      // Entry carried byte-for-byte, `mtime` included: nothing about the note changed, only
      // its key in the map. Per-file keys are derived from `blob:<content hash>` — content, not
      // path — so the ciphertext and its blob are untouched and no re-encryption is needed.
      delete files[op.from];
      delete visible[op.from];
      files[op.to] = entry;
      visible[op.to] = entry;
      return `moved ${op.from} to ${op.to}`;
    }

    const { entry, bytes, summary } = await this.#nextContent(op, visible);
    const c = await this.#view.store(entry.h, bytes);
    const stored = c === undefined ? entry : { ...entry, c };
    files[op.path] = stored;
    visible[op.path] = stored;
    return summary;
  }

  async #nextContent(
    op: Extract<WriteOp, { kind: "append" | "edit" | "write" }>,
    files: Record<string, FileEntry>
  ): Promise<{ entry: FileEntry; bytes: Uint8Array; summary: string }> {
    const existing = files[op.path];
    const current =
      existing === undefined ? null : new TextDecoder().decode(await this.#view.read(existing));

    let text: string;
    let summary: string;
    switch (op.kind) {
      case "append": {
        if (current === null) {
          text = op.text;
          summary = `created ${op.path}`;
        } else {
          // A newline is inserted only when the file does not already end with one, so
          // repeated appends do not accumulate blank lines.
          text = current.endsWith("\n") || current === "" ? current + op.text : `${current}\n${op.text}`;
          summary = `appended to ${op.path}`;
        }
        break;
      }
      case "edit": {
        if (current === null) throw new VaultError(`"${op.path}" does not exist, so there is nothing to edit`);
        // An empty anchor matches between every character, so `split`/`join` would interleave
        // `new_text` through the whole note and report a count nobody asked for — and on an
        // empty note the count comes out as -1, which is not a number of occurrences at all.
        // There is no sensible reading of "replace nothing", so it is refused rather than
        // interpreted.
        if (op.oldText === "") {
          throw new VaultError(
            `"old_text" is empty, so there is nothing to find. Give the exact text to replace.`
          );
        }
        const count = current.split(op.oldText).length - 1;
        // Zero still fails loud in both modes. "Replace every one of them" is not an answer to
        // "there are none of them", and silently succeeding would report an edit that no
        // subsequent read could find.
        if (count === 0) throw new VaultError(`the text to replace does not appear in "${op.path}"`);
        if (op.replaceAll === true) {
          text = current.split(op.oldText).join(op.newText);
          summary = `edited ${op.path} (${count} occurrence(s) replaced)`;
          break;
        }
        if (count > 1) {
          throw new VaultError(
            `the text to replace appears ${count} times in "${op.path}" — include enough surrounding context to make it unique, or pass replace_all to change all of them`
          );
        }
        text = current.replace(op.oldText, op.newText);
        summary = `edited ${op.path}`;
        break;
      }
      case "write": {
        // Unconditional create-or-replace, like `fs.writeFile` (owner's filesystem-semantics
        // call, 2026-08-31). The version-bound overwrite this used to require is retired for
        // the agent surface, and the trade is stated rather than hidden: a device edit racing
        // this write can be replaced without warning, recoverable only from snapshot history
        // within GC retention. Sync correctness is unaffected — the CAS mini-pass around this
        // still absorbs the live head and re-applies.
        text = op.content;
        summary = current === null ? `created ${op.path}` : `replaced ${op.path}`;
        break;
      }
    }

    const bytes = new TextEncoder().encode(text);
    const h = await sha256Hex(bytes);
    const lines = countLines(bytes);
    const entry: FileEntry = {
      h,
      size: bytes.length,
      mtime: Date.now(),
      ...(lines === null ? {} : { lines }),
    };
    return { entry, bytes, summary };
  }
}
