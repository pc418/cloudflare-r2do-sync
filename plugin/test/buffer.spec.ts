import { describe, expect, it } from "vitest";
import { exactArrayBuffer } from "../src/buffer";

describe("exactArrayBuffer", () => {
  it("returns an exact fixed ArrayBuffer without copying", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(exactArrayBuffer(bytes)).toBe(bytes.buffer);
  });

  it("copies only the bytes in an offset subview", () => {
    const padded = new Uint8Array([99, 1, 2, 3, 88]);
    const exact = exactArrayBuffer(padded.subarray(1, 4));
    expect(exact).not.toBe(padded.buffer);
    expect([...new Uint8Array(exact)]).toEqual([1, 2, 3]);
  });

  it("copies shared storage into a plain exact ArrayBuffer", () => {
    const shared = new SharedArrayBuffer(5);
    new Uint8Array(shared).set([99, 1, 2, 3, 88]);
    const exact = exactArrayBuffer(new Uint8Array(shared, 1, 3));
    expect(exact).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(exact)]).toEqual([1, 2, 3]);
  });

  it("copies resizable storage instead of exposing it to an async consumer", () => {
    const ResizableArrayBuffer = ArrayBuffer as typeof ArrayBuffer & {
      new (byteLength: number, options: { maxByteLength: number }): ArrayBuffer;
    };
    const resizable = new ResizableArrayBuffer(5, { maxByteLength: 10 });
    const bytes = new Uint8Array(resizable);
    bytes.set([99, 1, 2, 3, 88]);
    const exact = exactArrayBuffer(bytes.subarray(1, 4));
    expect(exact).not.toBe(resizable);
    expect((exact as ArrayBuffer & { readonly resizable?: boolean }).resizable).toBe(false);
    expect([...new Uint8Array(exact)]).toEqual([1, 2, 3]);
  });
});
