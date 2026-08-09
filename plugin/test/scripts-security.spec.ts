import { describe, expect, it } from "vitest";

const restore = await import(new URL("../../scripts/restore.mjs", import.meta.url).href);
const accessToken = await import(new URL("../../scripts/access-token.mjs", import.meta.url).href);
const setupLib = await import(new URL("../../scripts/setup-lib.mjs", import.meta.url).href);

describe("credential-bearing script endpoints", () => {
  for (const [name, normalize] of [
    ["restore", restore.normalizeServerUrl],
    ["access-token", accessToken.normalizeWorkerUrl],
    ["setup-lib", setupLib.normalizeWorkerUrl],
  ] as const) {
    it(`${name} requires HTTPS except on loopback`, () => {
      expect(normalize("https://sync.example.com/")).toBe("https://sync.example.com");
      expect(normalize("http://localhost:8787/")).toBe("http://localhost:8787");
      expect(normalize("http://127.0.0.2:8787")).toBe("http://127.0.0.2:8787");
      expect(() => normalize("http://sync.example.com")).toThrow(/HTTPS/);
      expect(() => normalize("http://192.168.1.2:8787")).toThrow(/HTTPS/);
      expect(() => normalize("https://secret@sync.example.com")).toThrow(/credentials/);
    });
  }
});
