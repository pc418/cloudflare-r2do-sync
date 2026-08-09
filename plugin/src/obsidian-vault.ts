import type { App } from "obsidian";
import type { VaultAdapter, VaultFile } from "./types";

/**
 * Vault bridge backed by Obsidian's DataAdapter rather than the loaded TFile tree.
 * The adapter is the only cross-platform API that also sees hidden `.obsidian` files.
 */
export class ObsidianVault implements VaultAdapter {
  constructor(private readonly app: App) {}

  async list(): Promise<VaultFile[]> {
    const files: VaultFile[] = [];
    await this.#listFolder("", files);
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  async #listFolder(folder: string, out: VaultFile[]): Promise<void> {
    const listed = await this.app.vault.adapter.list(folder);
    for (const path of [...listed.files].sort()) {
      const stat = await this.app.vault.adapter.stat(path);
      if (stat === null) throw new Error(`file disappeared while scanning: ${path}`);
      if (stat.type !== "file") throw new Error(`listed file is not a file: ${path}`);
      out.push({ path, size: stat.size, mtime: stat.mtime });
    }
    for (const path of [...listed.folders].sort()) {
      const stat = await this.app.vault.adapter.stat(path);
      if (stat === null) throw new Error(`folder disappeared while scanning: ${path}`);
      if (stat.type !== "folder") throw new Error(`listed folder is not a folder: ${path}`);
      await this.#listFolder(path, out);
    }
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
    await this.app.vault.adapter.writeBinary(path, bytes.slice().buffer as ArrayBuffer);
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
