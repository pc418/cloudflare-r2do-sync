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

    // The shared policy, not just the hard skips: a path this vault excludes is one ordinary
    // devices deliberately do not scan, so committing it would report success for a note that
    // never reaches anyone's disk.
    const inScope = await this.#view.scope();
    for (const path of ops.flatMap(opPaths)) {
      if (!inScope(path)) {
        throw new VaultError(
          `"${path}" is outside what this vault syncs (its exclude or only-paths policy), so writing it would publish a note no device would download`
        );
      }
    }

    let lastError: unknown = null;
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const snapshot = await this.#view.snapshot({ fresh: true });
      // The complete map, not `snapshot.files`. Excluded and hard-skipped entries are carried
      // through snapshots deliberately; building from the visible subset would delete every
      // one of them — silently destroying exactly what the vault takes most care to keep.
      const files: Record<string, FileEntry> = { ...snapshot.all };
      const applied: string[] = [];

      for (const op of ops) {
        // Sequential, and reading `files` as it goes, so two ops on one path in the same
        // batch chain instead of racing — the second sees what the first wrote.
        applied.push(await this.#applyOne(op, files));
      }

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
        if (!(error instanceof StaleHeadError)) throw error;
        lastError = error;
      }
    }
    throw new VaultError(
      `the vault kept moving under this write (${CAS_ATTEMPTS} attempts). Nothing was committed. ${String(lastError)}`
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
  async #applyOne(op: WriteOp, files: Record<string, FileEntry>): Promise<string> {
    if (op.kind === "delete") {
      // Deliberately no hash, no confirmation, no percent cap: `rm` semantics, owner's call.
      // Recovery is snapshot history within GC retention, which is what that budget buys.
      if (files[op.path] === undefined) {
        throw new VaultError(`"${op.path}" does not exist, so there is nothing to delete`);
      }
      delete files[op.path];
      return `deleted ${op.path}`;
    }

    if (op.kind === "move") {
      const entry = files[op.from];
      if (entry === undefined) {
        throw new VaultError(`"${op.from}" does not exist, so there is nothing to move`);
      }
      // The one deliberate departure from `rename`'s silent clobber. Overwriting a *different*
      // note by accident is the worst surprise this surface can produce, and an agent that
      // means it can delete the destination first.
      if (files[op.to] !== undefined) {
        throw new VaultError(
          `"${op.to}" already exists, so moving "${op.from}" onto it would replace a different note. Delete it first if that is what you want.`
        );
      }
      // Entry carried byte-for-byte, `mtime` included: nothing about the note changed, only
      // its key in the map. Per-file keys are derived from `blob:<content hash>` — content, not
      // path — so the ciphertext and its blob are untouched and no re-encryption is needed.
      delete files[op.from];
      files[op.to] = entry;
      return `moved ${op.from} to ${op.to}`;
    }

    const { entry, bytes, summary } = await this.#nextContent(op, files);
    const c = await this.#view.store(entry.h, bytes);
    files[op.path] = c === undefined ? entry : { ...entry, c };
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
