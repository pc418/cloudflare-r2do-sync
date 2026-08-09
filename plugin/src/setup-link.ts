import { fromBase64, parseMasterKey, parseVaultSalt, toBase64 } from "./crypto";

/**
 * Device setup by QR code.
 *
 * Typing a server URL, an access token and a 44-character master key on a phone is exactly
 * the kind of manual step that produces silent misconfiguration, so the desktop renders the
 * whole payload as a QR code encoding an `obsidian://` URI. The phone's own camera app opens
 * Obsidian directly, which means no camera or QR-scanning code has to ship in this plugin.
 *
 * The payload carries secrets. It is only ever rendered on screen at the user's request and
 * never persisted or transmitted.
 */
export const SETUP_ACTION = "r2do-sync-setup";

interface SetupPayloadBase {
  v: 2;
  /** Base URL of the sync Worker. */
  url: string;
  /** Device name recorded in commits — should be the *new* device's name. */
  name: string;
  /** Sync token for the new device — usually this device's own token, shared; optionally
   *  one minted just for it so it can be revoked on its own. */
  token: string;
}

export type SetupPayload =
  | (SetupPayloadBase & {
      mode: "encrypted";
      /** Already-derived vault master key, base64. The passphrase is never shared. */
      key: string;
      /** Public PBKDF2 vault salt, canonical base64. */
      vaultSalt: string;
    })
  | (SetupPayloadBase & {
      mode: "plaintext";
      key?: never;
      vaultSalt?: never;
    });

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  return fromBase64(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

export function encodeSetupPayload(payload: SetupPayload): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

/** The full URI a QR code should encode. */
export function encodeSetupUri(payload: SetupPayload): string {
  return `obsidian://${SETUP_ACTION}?d=${encodeSetupPayload(payload)}`;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`setup link is missing "${field}"`);
  }
  return value.trim();
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host === "::1") return true;
  const octets = host.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Normalizes a credential-bearing endpoint and refuses plaintext transport off loopback. */
export function normalizeServerUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("server URL must be a valid http(s) URL");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("server URL must not contain embedded credentials");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("server URL must be http(s)");
  }
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    throw new Error("server URL must use HTTPS (HTTP is allowed only for explicit loopback hosts)");
  }
  return parsed.toString().replace(/\/+$/, "");
}

/**
 * Parses whatever a user pasted into the setup box.
 *
 * The camera-to-Obsidian handoff does not always work: plenty of phone scanners open
 * `obsidian://` links in a browser, which drops them. Then the only way onto a phone is to
 * copy the link across and paste it, so this accepts the full URI, a bare `?d=…` query, or
 * the raw payload — and rejects anything else by name instead of half-configuring.
 */
export function parseSetupText(text: unknown): SetupPayload {
  if (typeof text !== "string" || text.trim() === "") {
    throw new Error("paste the setup link (or its payload) first");
  }
  const trimmed = text.trim();

  const fromQuery = /[?&]d=([^&\s]+)/.exec(trimmed);
  if (fromQuery !== null) return decodeSetupPayload(decodeURIComponent(fromQuery[1]));

  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed) || trimmed.includes("://")) {
    throw new Error(
      `that looks like a link but carries no "d=" payload — copy the whole ${SETUP_ACTION} link`
    );
  }
  // Not a URI at all: treat it as the payload the QR encodes.
  return decodeSetupPayload(trimmed);
}

/** Parses a scanned payload. Throws with a specific reason rather than half-configuring. */
export function decodeSetupPayload(data: unknown): SetupPayload {
  if (typeof data !== "string" || data === "") throw new Error("setup link has no payload");

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(data)));
  } catch {
    throw new Error("setup link payload is corrupt");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("setup link payload is not an object");
  }

  const raw = parsed as Record<string, unknown>;
  if (raw.v !== 2) throw new Error(`unsupported setup link version ${String(raw.v)}`);

  const url = normalizeServerUrl(requireString(raw.url, "url"));
  const common: SetupPayloadBase = {
    v: 2,
    url,
    name: requireString(raw.name, "name"),
    token: requireString(raw.token, "token"),
  };

  const mode = requireString(raw.mode, "mode");
  if (mode === "encrypted") {
    const key = requireString(raw.key, "key");
    parseMasterKey(key); // reject a malformed key here, not on the first push
    const vaultSalt = requireString(raw.vaultSalt, "vaultSalt");
    parseVaultSalt(vaultSalt);
    return { ...common, mode, key, vaultSalt };
  }
  if (mode === "plaintext") {
    if (raw.key !== undefined) {
      throw new Error('plaintext setup link must not contain "key"');
    }
    if (raw.vaultSalt !== undefined) {
      throw new Error('plaintext setup link must not contain "vaultSalt"');
    }
    return { ...common, mode };
  }
  throw new Error(`unsupported setup link encryption mode ${JSON.stringify(mode)}`);
}
