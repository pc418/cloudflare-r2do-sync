/**
 * Manifest ids are ULIDs: time-ordered, so history sorts without consulting a clock field.
 *
 * The plugin's own `ulid.ts` is a `SyncEngine` collaborator wired to an injectable clock; the
 * agent has no engine and no seam to inject, so this is the same 10+16 Crockford layout with
 * the real clock. The *format* is the contract (the server validates `ULID_RE`), not the
 * generator.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now: number = Date.now()): string {
  let time = "";
  let ms = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[ms % 32] + time;
    ms = Math.floor(ms / 32);
  }
  const rand = new Uint8Array(16);
  crypto.getRandomValues(rand);
  let tail = "";
  for (const byte of rand) tail += CROCKFORD[byte % 32];
  return time + tail;
}
