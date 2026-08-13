import type { App } from "obsidian";
import type { VaultAdapter, VaultFile } from "./types";
import { DEFAULT_LANES, clampLanes, mapPool } from "./pool";

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
}
