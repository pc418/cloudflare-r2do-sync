import { describe, expect, it } from "vitest";
import { SHORT_SNAPSHOT_LENGTH, shortSnapshot } from "../src/notify";

/**
 * Every snapshot id a person sees is the 7-character form. There is no setting for it any more,
 * which removes the *runtime* way to get this wrong — but not the authoring one: a new dialog
 * that interpolates `${summary.head}` renders a 26-character id beside a notice showing seven,
 * and the reader's first job becomes working out whether they are the same snapshot.
 *
 * So this is a source scan, and deliberately so. The alternative is a rendering test per dialog,
 * and the four that already existed are exactly the ones that drifted — the surfaces are cheap
 * to add and each new one would need remembering. A scan fails on the next one automatically.
 *
 * `formatLogNote` is the one deliberate exception and lives in `log.ts`, which is not scanned:
 * the exported log is a file rather than a screen, and `GET /api/manifests/:id` wants the whole
 * id, so truncating it there would make a bug report's ids unusable for actually fetching
 * anything.
 */
import SOURCE from "../src/main.ts?raw";

/** Expressions that hold a full manifest id. A raw one inside a template literal is the bug. */
const ID_EXPRESSIONS = [
  "summary.head",
  "summary.lastHead",
  "preview.head",
  "snap.id",
  "this.snap.id",
  "result.head",
];

describe("snapshot ids on screen", () => {
  it.each(ID_EXPRESSIONS)("never interpolates %s into user-facing text unshortened", (expr) => {
    // `${expr}` directly in a template literal, as opposed to `${shortSnapshot(expr)}`.
    const raw = new RegExp(`\\$\\{\\s*${expr.replace(/\./g, "\\.")}\\s*\\}`, "g");
    const hits = SOURCE.match(raw) ?? [];
    expect(hits, `${expr} is interpolated raw; wrap it in shortSnapshot()`).toEqual([]);
  });

  it("abbreviates from the entropy end, so two ids never collapse to the same label", () => {
    // ULIDs share a timestamp prefix. Two snapshots made in the same ~33 s window differ only
    // in the suffix, which is exactly the pair a continuity dialog puts side by side.
    const a = "01K2QWERTYABCDEFGHJKMNPQRS";
    const b = "01K2QWERTYABCDEFGHJZZZZZZZ";
    expect(a.slice(0, 19)).toBe(b.slice(0, 19));
    expect(shortSnapshot(a)).not.toBe(shortSnapshot(b));
    expect(shortSnapshot(a)).toHaveLength(SHORT_SNAPSHOT_LENGTH);
  });
});
