import type { App } from "obsidian";
import type { VaultAdapter, VaultFile } from "./types";
import { DEFAULT_LANES, clampLanes, mapPool } from "./pool";
import { ancestorDirs, deepestFirst } from "./paths";

/**
 * Vault bridge backed by Obsidian's DataAdapter rather than the loaded TFile tree.
 * The adapter is the only cross-platform API that also sees hidden `.obsidian` files.
 */
export class ObsidianVault implements VaultAdapter {
  readonly #lanes: number;

  constructor(
    private readonly app: App,
    lanes = DEFAULT_LANES
  ) {
    this.#lanes = clampLanes(lanes);
  }

  async list(): Promise<VaultFile[]> {
    const files: VaultFile[] = [];
    let folders = [""];
    while (folders.length > 0) {
      const listings = await mapPool(folders, this.#lanes, async (folder) =>
        this.app.vault.adapter.list(folder)
      );
      const paths = listings.flatMap((listed) => listed.files);
      const layerFiles = await mapPool(paths, this.#lanes, async (path): Promise<VaultFile> => {
        const stat = await this.app.vault.adapter.stat(path);
        if (stat === null) throw new Error(`file disappeared while scanning: ${path}`);
        if (stat.type !== "file") throw new Error(`listed file is not a file: ${path}`);
        return { path, size: stat.size, mtime: stat.mtime };
      });
      files.push(...layerFiles);
      // list() already classifies these as folders. Their own list() call is the fail-loud
      // validation and avoids a redundant stat per directory.
      folders = listings.flatMap((listed) => listed.folders);
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Folders holding no file anywhere beneath them, deepest first.
   *
   * One walk, and **no stats**: this needs paths, never `size`/`mtime`, so it costs a directory
   * listing per folder rather than `list()`'s stat per file. A folder is file-free when its own
   * listing has no files and neither does any folder under it, which is computed here by
   * marking every ancestor of every file seen — the complement is the answer.
   */
  async emptyFolders(): Promise<string[]> {
    const seen: string[] = [];
    const holdsFile = new Set<string>();
    let layer = [""];
    while (layer.length > 0) {
      const listings = await mapPool(layer, this.#lanes, async (folder) =>
        this.app.vault.adapter.list(folder)
      );
      for (const listed of listings) {
        for (const file of listed.files) for (const dir of ancestorDirs(file)) holdsFile.add(dir);
      }
      layer = listings.flatMap((listed) => listed.folders);
      // The root is never a candidate, and it is the one folder never pushed here.
      seen.push(...layer);
    }
    return deepestFirst(seen.filter((dir) => !holdsFile.has(dir)));
  }

  /**
   * Whether a file is at this path right now. A stat per path, deliberately: checking a
   * handful of conflict copies must not cost a recursive walk of the whole vault.
   */
  async exists(path: string): Promise<boolean> {
    return (await this.app.vault.adapter.stat(path))?.type === "file";
  }

  async stat(path: string): Promise<VaultFile | null> {
    const stat = await this.app.vault.adapter.stat(path);
    if (stat === null) return null;
    if (stat.type !== "file") throw new Error(`journaled path is not a file: ${path}`);
    return { path, size: stat.size, mtime: stat.mtime };
  }

  async read(path: string): Promise<Uint8Array> {
    const stat = await this.app.vault.adapter.stat(path);
    if (stat?.type !== "file") throw new Error(`not a file: ${path}`);
    return new Uint8Array(await this.app.vault.adapter.readBinary(path));
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const existing = await this.app.vault.adapter.stat(path);
    if (existing?.type === "folder") throw new Error(`not a file: ${path}`);
    await this.#ensureFolder(path);
    await this.app.vault.adapter.writeBinary(path, bytes.slice().buffer);
  }

  /** Pulled files may land in folders this vault has never had. */
  async #ensureFolder(path: string): Promise<void> {
    const slash = path.lastIndexOf("/");
    if (slash < 0) return;
    let current = "";
    for (const segment of path.slice(0, slash).split("/")) {
      current = current ? `${current}/${segment}` : segment;
      const existing = await this.app.vault.adapter.stat(current);
      if (existing?.type === "folder") continue;
      if (existing !== null) throw new Error(`parent path is not a folder: ${current}`);
      try {
        await this.app.vault.adapter.mkdir(current);
      } catch (error) {
        // Tolerate only the race where another operation created the folder first.
        const raced = await this.app.vault.adapter.stat(current);
        if (raced?.type !== "folder") throw error;
      }
    }
  }

  /** Trashed, not destroyed: a deletion pulled from another device stays recoverable. */
  async remove(path: string): Promise<void> {
    const stat = await this.app.vault.adapter.stat(path);
    if (stat?.type !== "file") throw new Error(`not a file: ${path}`);
    if (!(await this.app.vault.adapter.trashSystem(path))) {
      await this.app.vault.adapter.trashLocal(path);
    }
  }

  /**
   * Removes a folder only when a fresh listing shows it truly empty, so nothing is trashed:
   * an empty folder has no content to lose. The listing is the whole safety property — a
   * folder still holding an excluded, skipped or unscanned file is not empty to `list()` and
   * therefore survives, without this needing to know the sync policy.
   */
  async removeFolderIfEmpty(path: string): Promise<boolean> {
    const stat = await this.app.vault.adapter.stat(path);
    if (stat?.type !== "folder") return false;
    const listed = await this.app.vault.adapter.list(path);
    if (listed.files.length > 0 || listed.folders.length > 0) return false;
    try {
      // Preferred: anything that appeared since the listing has to fail this call rather than
      // be deleted by it. Not supported everywhere — see the fallback below.
      await this.app.vault.adapter.rmdir(path, false);
    } catch (error) {
      // Tolerate only the two races, as `#ensureFolder` does: another actor removed the
      // folder first, or something appeared inside it between the listing and the rmdir.
      const raced = await this.app.vault.adapter.stat(path);
      if (raced === null) return true;
      if (raced.type !== "folder") throw error;
      const relisted = await this.app.vault.adapter.list(path);
      if (relisted.files.length > 0 || relisted.folders.length > 0) return false;
      // Still standing, still empty: this is the platform refusing the call, not refusing the
      // folder. Desktop maps `rmdir` onto `fs.rm`, which rejects EVERY directory unless
      // `recursive` is true — "rm returned EISDIR" — so the documented "if false the folder
      // needs to be empty" contract is unreachable there and the non-recursive call can never
      // succeed. Emptiness has just been re-verified against a *fresh* listing one microtask
      // ago, so `true` has nothing to recurse into; and if this fails too it throws, which is
      // what keeps a genuine EPERM/EIO loud rather than stranding the folder silently.
      await this.app.vault.adapter.rmdir(path, true);
    }
    return true;
  }
}
