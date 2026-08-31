import { describe, expect, it } from "vitest";
import type { ButtonComponent } from "obsidian";
import { markDestructive } from "../src/main";

/**
 * `setDestructive` arrived in Obsidian 1.13 and deprecates `setWarning`. `minAppVersion` here
 * is 1.5.0, so both calls have to stay reachable and the choice is made at runtime, per
 * button. Both branches are asserted directly because a rendered-settings test only ever
 * exercises whichever one the fake happens to implement.
 */
describe("markDestructive", () => {
  function stub(modern: boolean): ButtonComponent & { calls: string[] } {
    const calls: string[] = [];
    const b = {
      calls,
      setWarning(): unknown {
        calls.push("setWarning");
        return b;
      },
    } as unknown as ButtonComponent & { calls: string[] };
    if (modern) {
      (b as unknown as { setDestructive: () => unknown }).setDestructive = (): unknown => {
        calls.push("setDestructive");
        return b;
      };
    }
    return b;
  }

  it("prefers setDestructive when the running app has it", () => {
    const b = stub(true);
    expect(markDestructive(b)).toBe(b);
    expect(b.calls).toEqual(["setDestructive"]);
  });

  it("falls back to setWarning on an app that predates it", () => {
    const b = stub(false);
    expect(markDestructive(b)).toBe(b);
    expect(b.calls).toEqual(["setWarning"]);
  });
});
