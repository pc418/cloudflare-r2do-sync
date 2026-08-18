import assert from "node:assert/strict";
import { test } from "node:test";
import { generateVault, renamePlan } from "./bench-vault.mjs";

test("same seed generates byte-identical vaults", () => {
  const a = generateVault({ files: 40, seed: 7 });
  const b = generateVault({ files: 40, seed: 7 });
  assert.deepEqual([...a.entries()], [...b.entries()]);
});

test("different seeds differ and the file count is exact", () => {
  const a = generateVault({ files: 40, seed: 7 });
  const b = generateVault({ files: 40, seed: 8 });
  assert.equal(a.size, 40);
  assert.equal(b.size, 40);
  assert.notDeepEqual([...a.entries()], [...b.entries()]);
});

test("sizes stay inside the documented spread", () => {
  const vault = generateVault({ files: 200, seed: 1 });
  for (const contents of vault.values()) {
    assert.ok(contents.length >= 5, "a note has a heading at minimum");
    assert.ok(contents.length < 200_000, "the long tail is bounded");
  }
});

test("renamePlan is deterministic, collision-free, and leaves sources behind", () => {
  const vault = generateVault({ files: 120, seed: 3 });
  const plan = renamePlan(vault, 50);
  assert.equal(plan.length, 50);
  assert.equal(new Set(plan.map((m) => m.to)).size, 50, "renamed basenames must not collide");
  for (const move of plan) {
    assert.ok(vault.has(move.from));
    assert.ok(move.to.startsWith("renamed/"));
  }
  assert.deepEqual(plan, renamePlan(vault, 50));
});
