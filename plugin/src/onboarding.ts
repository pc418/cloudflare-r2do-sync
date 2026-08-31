/**
 * Joining a vault by hand: ask the server what it is, then prove the key before saving.
 *
 * The mistake this exists to make impossible was found in the wild: a device configured with
 * an agent-Worker URL, a token matching no live credential, and a freshly minted master key
 * that opened nothing — every one of them accepted silently at entry time, and the first
 * evidence of any of it was a failed pass much later.
 *
 * So nothing here writes settings. The caller gets an answer it can refuse on, and the whole
 * join is then handed to `applySetup` as a `SetupPayload` — the same path a setup link takes.
 * A second apply implementation drifting from that one is the hazard this design avoids.
 */
import { ApiError, type SyncApi } from "./api";
import { VaultCrypto, manifestAad, parseVaultSalt } from "./crypto";
import { isSettingsDoc } from "./settings-doc";
import type { SetupPayload } from "./setup-link";
import { parseFileEntries, type Manifest } from "./types";

/** What the server says this vault is. The distinction the old form never made. */
export type RemoteKind = "empty" | "encrypted" | "plaintext";

export interface RemoteProbe {
  kind: RemoteKind;
  head: string | null;
  /** The head manifest, kept so the entered key can be proven against real ciphertext. */
  manifest: Manifest | null;
  /**
   * The canonical salt from the published settings document, when one exists.
   *
   * Never typed by a user and never guessed: the vault's published `vaultSalt` is canonical
   * and a device's own generated salt is provisional and yields to it. Null means no document
   * has been published yet, which is a real state on a fresh vault.
   */
  vaultSalt: string | null;
}

/**
 * Asks the server what it holds. Reads only — this is safe to run against any URL.
 *
 * A transport or auth failure propagates: "I could not tell" must never be reported as
 * "empty vault", because that is the answer that leads to minting a key over someone's
 * existing snapshots.
 */
export async function probeRemote(api: SyncApi): Promise<RemoteProbe> {
  const head = await api.getHead();
  if (head === null) {
    return { kind: "empty", head: null, manifest: null, vaultSalt: await publishedSalt(api) };
  }
  const manifest = await api.getManifest(head);
  return {
    kind: manifest.v === 1 ? "plaintext" : "encrypted",
    head,
    manifest,
    vaultSalt: await publishedSalt(api),
  };
}

/**
 * The salt on the shared settings document's clear envelope, or null.
 *
 * A 404 is a real answer — no document published yet. Anything else is not evidence of
 * absence, so it propagates rather than quietly producing a device that adopts a salt of its
 * own invention.
 */
async function publishedSalt(api: SyncApi): Promise<string | null> {
  let raw: unknown;
  try {
    raw = await api.getSettingsDoc();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
  if (!isSettingsDoc(raw)) return null;
  const salt = raw.vaultSalt;
  if (salt === undefined) return null;
  // Validated here rather than trusted: it is about to become this device's canonical salt.
  parseVaultSalt(salt);
  return salt;
}

/**
 * Proves an entered master key actually opens this vault, by decrypting its head manifest.
 *
 * This is the whole point of the form. A key is not "probably right" because it parses — the
 * old flow minted a well-formed key that opened nothing — so the test is the real ciphertext
 * the vault already holds, before a single setting is written.
 *
 * Throws with a message meant to be read by the person who typed the key.
 */
export async function proveMasterKey(manifest: Manifest, keyText: string): Promise<void> {
  if (manifest.v === 1) {
    throw new Error("this vault is plaintext, so it has no master key to check");
  }
  let crypto: VaultCrypto;
  try {
    crypto = await VaultCrypto.fromText(keyText);
  } catch (error) {
    throw new Error(
      `that master key is not readable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  // Cheap and exact, and it gives the common failure its own sentence. The decrypt below is
  // still what decides — a matching id proves only that two keys derive the same 8 bytes.
  if (crypto.keyId !== manifest.keyId) {
    throw new Error(
      "that master key does not belong to this vault — its snapshots were written with a " +
        "different key. Paste a setup link from a device that already syncs, or use the key " +
        "saved when the vault was created."
    );
  }
  try {
    const files = await crypto.decryptJson(
      manifest.enc,
      manifest.v === 3 ? manifestAad(manifest) : undefined
    );
    // Decrypting is the proof; parsing guards against a payload that authenticates but is not
    // a path map, which would otherwise surface much later as a broken first sync.
    parseFileEntries(files);
  } catch (error) {
    throw new Error(
      `that master key did not open this vault's latest snapshot: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

/**
 * The payload a setup link would have carried, assembled from typed fields.
 *
 * `vaultSalt` is deliberately not a parameter a user can reach: it is the published canonical
 * salt when there is one, and otherwise the provisional salt this device already holds.
 */
export function joinPayload(input: {
  url: string;
  token: string;
  name: string;
  kind: RemoteKind;
  /** Required for an encrypted vault; for `empty` this is the key about to be created. */
  key?: string;
  publishedSalt: string | null;
  provisionalSalt: string;
}): SetupPayload {
  const base = { v: 2 as const, url: input.url, name: input.name, token: input.token };
  if (input.kind === "plaintext") return { ...base, mode: "plaintext" };
  const key = (input.key ?? "").trim();
  if (key === "") throw new Error("an encrypted vault needs its master key");
  return {
    ...base,
    mode: "encrypted",
    key,
    vaultSalt: input.publishedSalt ?? input.provisionalSalt,
  };
}

/** What the form says about a probed vault, above the fields it just revealed. */
export function probeSummary(probe: RemoteProbe): string {
  switch (probe.kind) {
    case "empty":
      return (
        "This vault is empty — no snapshots yet. Continuing sets this device up as its first " +
        "device and creates the vault's master key, which you will be asked to save before " +
        "anything is uploaded."
      );
    case "plaintext":
      return (
        "This vault already has snapshots and is not encrypted, so there is no master key to " +
        "enter. This device will join it as it is."
      );
    case "encrypted":
      return (
        "This vault already has snapshots and is encrypted. Joining it needs its master key — " +
        "paste a setup link from a device that already syncs, or enter the key saved when the " +
        "vault was created. The key is checked against this vault before anything is saved."
      );
  }
}
