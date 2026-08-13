import { describe, it, expect } from "vitest";
import { sha256Hex } from "../src/hash";

const enc = (s: string) => new TextEncoder().encode(s);

describe("sha256Hex", () => {
  it("matches known vectors", async () => {
    expect(await sha256Hex(enc(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    expect(await sha256Hex(enc("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("is lowercase 64-char hex", async () => {
    const h = await sha256Hex(enc("daily log entry"));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("handles binary bytes and is byte-exact (not text-normalized)", async () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x10, 0x80, 0x7f]);
    const h1 = await sha256Hex(bytes);
    const h2 = await sha256Hex(new Uint8Array([0x00, 0xff, 0x10, 0x80, 0x7e]));
    expect(h1).not.toBe(h2);
  });

  it("accepts ArrayBuffer as well as Uint8Array", async () => {
    const u8 = enc("same content");
    const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    expect(await sha256Hex(ab)).toBe(await sha256Hex(u8));
  });

  it("hashes only an offset subview", async () => {
    const padded = new TextEncoder().encode("outsideabcoutside");
    expect(await sha256Hex(padded.subarray(7, 10))).toBe(await sha256Hex(enc("abc")));
  });
});
