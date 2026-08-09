import { describe, expect, it } from "vitest";
import { dataResponsibility, firstSyncConsentBody, needsFirstSyncConsent } from "../src/main";

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

// This gate is also the only place the self-hosting disclaimer is *accepted* rather than
// merely displayed. The first-run settings panel shows the same words, but nothing there
// requires an answer, and a device set up from a QR link never lingers on that panel at all.
describe("first-sync consent copy", () => {
  it.each(["encrypted", "plaintext"] as const)("carries the %s disclaimer verbatim", (mode) => {
    expect(firstSyncConsentBody(mode)).toContain(dataResponsibility(mode));
  });

  it.each(["encrypted", "plaintext"] as const)("still leads with the pass itself (%s)", (mode) => {
    expect(firstSyncConsentBody(mode)[0]).toContain("reconciles two");
  });

  it("promises confidentiality only where it is true", () => {
    expect(dataResponsibility("encrypted")).toContain("only you hold");
    expect(dataResponsibility("encrypted")).toContain("master key");
  });

  // The bug this replaced: one fixed string told plaintext users that nobody else could read
  // their notes, in a dialog they had to accept, moments before uploading them in the clear.
  it("tells a plaintext vault the provider can read everything", () => {
    const text = dataResponsibility("plaintext");
    expect(text).toContain("encryption is turned OFF");
    expect(text).toContain("file paths");
    expect(text).toMatch(/provider/);
    expect(text).not.toMatch(/only you hold|nobody else can read/);
  });

  it.each(["encrypted", "plaintext"] as const)("keeps the %s duties and the warranty", (mode) => {
    expect(dataResponsibility(mode)).toContain("backups");
    expect(dataResponsibility(mode)).toMatch(/without warranty/i);
  });
});
