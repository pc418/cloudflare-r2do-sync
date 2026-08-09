import { reset } from "cloudflare:test";
import { beforeEach } from "vitest";

// Keep storage isolation explicit across pool upgrades. Tests that need an authenticated
// device register their own beforeEach after this hook and mint against the fresh DO.
beforeEach(async () => {
  await reset();
});
