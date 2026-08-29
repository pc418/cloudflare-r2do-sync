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
  | { kind: "edit"; path: string; oldText: string; newText: string }
  | { kind: "write"; path: string; content: string; expectedHash?: string };

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
    this.#configDir = opts.configDir ?? ".obsidian";
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
    for (const op of ops) {
      const refusal = refuseWrite(op.path, this.#configDir);
      if (refusal !== null) throw new VaultError(refusal);
    }

    let lastError: unknown = null;
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const snapshot = await this.#view.snapshot({ fresh: true });
      const files: Record<string, FileEntry> = { ...snapshot.files };
      const applied: string[] = [];

      for (const op of ops) {
        // Sequential, and reading `files` as it goes, so two ops on one path in the same
        // batch chain instead of racing — the second sees what the first wrote.
        const next = await this.#applyOne(op, files);
        const c = await this.#view.store(next.entry.h, next.bytes);
        files[op.path] = c === undefined ? next.entry : { ...next.entry, c };
        applied.push(next.summary);
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

  async #applyOne(
    op: WriteOp,
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
        if (count === 0) throw new VaultError(`the text to replace does not appear in "${op.path}"`);
        if (count > 1) {
          throw new VaultError(
            `the text to replace appears ${count} times in "${op.path}" — include enough surrounding context to make it unique`
          );
        }
        text = current.replace(op.oldText, op.newText);
        summary = `edited ${op.path}`;
        break;
      }
      case "write": {
        // An overwrite is approval for one specific version and is bound to it. Creating is
        // free — there is nothing to lose — but replacing is not, so an absent hash is a
        // refusal rather than a default. Without that, a model that never read the note could
        // discard it wholesale on a guessed path, which is the one accident this surface
        // cannot offer an undo for.
        if (current !== null && op.expectedHash === undefined) {
          throw new VaultError(
            `"${op.path}" already exists. Read it first and pass expected_hash to replace it, or use append/edit to change part of it.`
          );
        }
        if (current !== null && existing.h !== op.expectedHash) {
          throw new VaultError(
            `"${op.path}" changed since it was read (${existing.h.slice(0, 8)} now, expected ${(op.expectedHash ?? "").slice(0, 8)}). Nothing was written; read it again.`
          );
        }
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
