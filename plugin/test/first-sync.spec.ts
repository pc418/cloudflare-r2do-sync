import { describe, expect, it } from "vitest";
import { needsFirstSyncConsent } from "../src/main";

// The first pass on a fresh device is the only one that reconciles two collections of real
// files. The key-backup gate protects the key, not the notes, and the mass-change guard
// fires *during* a pass — neither warns before the pass that has the most to lose.

describe("needsFirstSyncConsent", () => {
  it("asks a device that has never synced", () => {
    expect(needsFirstSyncConsent({ acknowledged: false, hasSyncedSnapshot: false })).toBe(true);
  });

  it("never asks twice", () => {
    expect(needsFirstSyncConsent({ acknowledged: true, hasSyncedSnapshot: false })).toBe(false);
  });

  it("does not ask a device that already holds a synced snapshot", () => {
    // Upgrades: the reconciliation this gate warns about already happened, so asking now
    // would only train the user to click through a warning that no longer applies.
    expect(needsFirstSyncConsent({ acknowledged: false, hasSyncedSnapshot: true })).toBe(false);
  });

  it("stays quiet once both are true", () => {
    expect(needsFirstSyncConsent({ acknowledged: true, hasSyncedSnapshot: true })).toBe(false);
  });
});
