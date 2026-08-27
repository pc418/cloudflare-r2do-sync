import { describe, expect, it } from "vitest";
import { ObsidianVault } from "../src/obsidian-vault";

type Entry =
  | { type: "file"; bytes: Uint8Array; mtime: number }
  | { type: "folder" };

class FakeDataAdapter {
  readonly entries = new Map<string, Entry>([["", { type: "folder" }]]);
  readonly systemTrash: string[] = [];
  readonly localTrash: string[] = [];
  systemTrashAvailable = true;
  readonly statCalls: string[] = [];
  readonly listCalls: string[] = [];
  readonly rmdirCalls: Array<{ path: string; recursive: boolean }> = [];

  addFile(path: string, text: string, mtime = 1): void {
    this.entries.set(path, { type: "file", bytes: new TextEncoder().encode(text), mtime });
    const parts = path.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      this.entries.set(parts.slice(0, i).join("/"), { type: "folder" });
    }
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    this.listCalls.push(path);
    const prefix = path === "" ? "" : `${path}/`;
    const files: string[] = [];
    const folders = new Set<string>();
    for (const [candidate, entry] of this.entries) {
      if (candidate === path || !candidate.startsWith(prefix)) continue;
      const rest = candidate.slice(prefix.length);
      if (rest.includes("/")) {
        folders.add(`${prefix}${rest.split("/")[0]}`);
      } else if (entry.type === "file") {
        files.push(candidate);
      } else {
        folders.add(candidate);
      }
    }
    return { files: files.sort(), folders: [...folders].sort() };
  }

  async stat(path: string): Promise<{ type: "file" | "folder"; ctime: number; mtime: number; size: number } | null> {
    this.statCalls.push(path);
    const entry = this.entries.get(path);
    if (entry === undefined) return null;
    if (entry.type === "folder") return { type: "folder", ctime: 0, mtime: 0, size: 0 };
    return { type: "file", ctime: 0, mtime: entry.mtime, size: entry.bytes.byteLength };
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const entry = this.entries.get(path);
    if (entry?.type !== "file") throw new Error(`not a file: ${path}`);
    return entry.bytes.slice().buffer;
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    const existing = this.entries.get(path);
    if (existing?.type === "folder") throw new Error(`not a file: ${path}`);
    this.entries.set(path, { type: "file", bytes: new Uint8Array(data.slice(0)), mtime: 2 });
  }

  async mkdir(path: string): Promise<void> {
    if (this.entries.has(path)) throw new Error(`already exists: ${path}`);
    this.entries.set(path, { type: "folder" });
  }

  async rmdir(path: string, recursive: boolean): Promise<void> {
    this.rmdirCalls.push({ path, recursive });
    const entry = this.entries.get(path);
    if (entry?.type !== "folder") throw new Error(`not a folder: ${path}`);
    const prefix = `${path}/`;
    const inside = [...this.entries.keys()].filter((p) => p.startsWith(prefix));
    if (!recursive && inside.length > 0) throw new Error(`directory not empty: ${path}`);
    for (const p of inside) this.entries.delete(p);
    this.entries.delete(path);
  }

  async trashSystem(path: string): Promise<boolean> {
    if (!this.systemTrashAvailable) return false;
    this.systemTrash.push(path);
    this.entries.delete(path);
    return true;
  }

  async trashLocal(path: string): Promise<void> {
    this.localTrash.push(path);
    this.entries.delete(path);
  }
}

function vault(adapter: FakeDataAdapter, lanes = 4): ObsidianVault {
  return new ObsidianVault({ vault: { adapter } } as never, lanes);
}

describe("ObsidianVault DataAdapter bridge", () => {
  it("recursively lists ordinary and hidden config files", async () => {
    const adapter = new FakeDataAdapter();
    adapter.addFile("note.md", "note", 10);
    adapter.addFile(".obsidian/app.json", "{}", 20);
    adapter.addFile(".obsidian/plugins/other/data.json", "secret", 30);

    await expect(vault(adapter).list()).resolves.toEqual([
      { path: ".obsidian/app.json", size: 2, mtime: 20 },
      { path: ".obsidian/plugins/other/data.json", size: 6, mtime: 30 },
      { path: "note.md", size: 4, mtime: 10 },
    ]);
    expect(adapter.statCalls).toEqual([
      expect.stringMatching(/\.json$|\.md$/),
      expect.stringMatching(/\.json$|\.md$/),
      expect.stringMatching(/\.json$|\.md$/),
    ]);
    expect(adapter.statCalls).not.toContain(".obsidian");
    expect(adapter.statCalls).not.toContain(".obsidian/plugins");
  });

  it("keeps deterministic output under shuffled bounded adapter completion", async () => {
    const adapter = new FakeDataAdapter();
    adapter.addFile("z/slow.md", "slow", 30);
    adapter.addFile("a/fast.md", "fast", 10);
    adapter.addFile("m/mid.md", "mid", 20);
    let active = 0;
    let peak = 0;
    const originalList = adapter.list.bind(adapter);
    adapter.list = async (path) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, path === "z" ? 8 : 1));
      try {
        return await originalList(path);
      } finally {
        active--;
      }
    };

    await expect(vault(adapter, 2).list()).resolves.toEqual([
      { path: "a/fast.md", size: 4, mtime: 10 },
      { path: "m/mid.md", size: 3, mtime: 20 },
      { path: "z/slow.md", size: 4, mtime: 30 },
    ]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("propagates a stat failure only after in-flight lanes settle and starts no straggler", async () => {
    const adapter = new FakeDataAdapter();
    adapter.addFile("a.md", "a");
    adapter.addFile("b.md", "b");
    adapter.addFile("c.md", "c");
    const started: string[] = [];
    let active = 0;
    const originalStat = adapter.stat.bind(adapter);
    adapter.stat = async (path) => {
      started.push(path);
      active++;
      try {
        await new Promise((resolve) => setTimeout(resolve, path === "a.md" ? 1 : 8));
        if (path === "a.md") throw new Error("stat failed");
        return await originalStat(path);
      } finally {
        active--;
      }
    };

    await expect(vault(adapter, 2).list()).rejects.toThrow(/stat failed/);
    expect(active).toBe(0);
    expect(started).toEqual(["a.md", "b.md"]);
  });

  it("creates parents, writes, reads, and trashes through the adapter", async () => {
    const adapter = new FakeDataAdapter();
    const bridge = vault(adapter);
    await bridge.write(".obsidian/plugins/theme/data.json", new TextEncoder().encode("ok"));
    await expect(bridge.read(".obsidian/plugins/theme/data.json")).resolves.toEqual(
      new TextEncoder().encode("ok")
    );
    expect(adapter.entries.get(".obsidian/plugins/theme")).toEqual({ type: "folder" });
    await bridge.remove(".obsidian/plugins/theme/data.json");
    expect(adapter.systemTrash).toEqual([".obsidian/plugins/theme/data.json"]);
  });

  it("falls back to local trash only when system trash reports unavailable", async () => {
    const adapter = new FakeDataAdapter();
    adapter.systemTrashAvailable = false;
    adapter.addFile("note.md", "note");
    await vault(adapter).remove("note.md");
    expect(adapter.localTrash).toEqual(["note.md"]);
  });

  it("fails loudly when a parent segment is a file", async () => {
    const adapter = new FakeDataAdapter();
    adapter.addFile(".obsidian", "not a folder");
    await expect(vault(adapter).write(".obsidian/app.json", new Uint8Array([1])))
      .rejects.toThrow(/not a folder/);
  });
});

// A folder is removed on the evidence of a fresh listing and nothing else. That listing is
// what keeps excluded, skipped and unscanned files safe without this knowing the sync policy.
describe("ObsidianVault.removeFolderIfEmpty", () => {
  /** A folder chain holding no file at all — what a moved-away subtree leaves behind. */
  const emptyFolder = (path: string): FakeDataAdapter => {
    const adapter = new FakeDataAdapter();
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      adapter.entries.set(parts.slice(0, i).join("/"), { type: "folder" });
    }
    return adapter;
  };

  it("removes a folder a fresh listing shows empty, without recursing", async () => {
    const adapter = emptyFolder("a/b");
    await expect(vault(adapter).removeFolderIfEmpty("a/b")).resolves.toBe(true);
    expect(adapter.rmdirCalls).toEqual([{ path: "a/b", recursive: false }]);
    expect(adapter.entries.has("a/b")).toBe(false);
  });

  it("keeps a folder that still holds a file", async () => {
    const adapter = new FakeDataAdapter();
    adapter.addFile("a/b/excluded.png", "binary");
    await expect(vault(adapter).removeFolderIfEmpty("a/b")).resolves.toBe(false);
    expect(adapter.rmdirCalls).toEqual([]);
  });

  it("keeps a folder that still holds a subfolder", async () => {
    const adapter = emptyFolder("a/b/c");
    await expect(vault(adapter).removeFolderIfEmpty("a/b")).resolves.toBe(false);
    expect(adapter.rmdirCalls).toEqual([]);
  });

  it("reports no removal for a path that is already gone, or is a file", async () => {
    const adapter = new FakeDataAdapter();
    adapter.addFile("a/note.md", "note");
    await expect(vault(adapter).removeFolderIfEmpty("a/gone")).resolves.toBe(false);
    await expect(vault(adapter).removeFolderIfEmpty("a/note.md")).resolves.toBe(false);
    expect(adapter.rmdirCalls).toEqual([]);
  });

  it("counts a folder another actor removed first as removed", async () => {
    const adapter = emptyFolder("a/b");
    adapter.rmdir = async (path) => {
      adapter.entries.delete(path);
      throw new Error("ENOENT");
    };
    await expect(vault(adapter).removeFolderIfEmpty("a/b")).resolves.toBe(true);
  });

  it("keeps a folder something appeared inside between the listing and the rmdir", async () => {
    const adapter = emptyFolder("a/b");
    adapter.rmdir = async (path) => {
      adapter.addFile(`${path}/raced.md`, "raced");
      throw new Error("ENOTEMPTY");
    };
    await expect(vault(adapter).removeFolderIfEmpty("a/b")).resolves.toBe(false);
    expect(adapter.entries.has("a/b/raced.md")).toBe(true);
  });

  it("propagates an rmdir failure that is neither race", async () => {
    const adapter = emptyFolder("a/b");
    adapter.rmdir = async (path) => {
      adapter.entries.set(path, { type: "file", bytes: new Uint8Array(), mtime: 1 });
      throw new Error("EPERM");
    };
    await expect(vault(adapter).removeFolderIfEmpty("a/b")).rejects.toThrow(/EPERM/);
  });
});
