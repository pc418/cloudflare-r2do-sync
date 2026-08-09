import type { Env as WorkerEnv } from "../src/index";

declare global {
  namespace Cloudflare {
    // Augmenting `Cloudflare.Env` needs an interface: a type alias cannot merge into a
    // namespace, and vitest-pool-workers reads exactly this declaration.
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- see above
    interface Env extends WorkerEnv {}
  }
}

export {};
