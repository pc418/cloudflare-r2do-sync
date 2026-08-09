export const SYNC_MODES = ["two-way", "pull-only", "push-only"] as const;
export type SyncMode = (typeof SYNC_MODES)[number];

export function isSyncMode(value: unknown): value is SyncMode {
  return typeof value === "string" && SYNC_MODES.includes(value as SyncMode);
}
