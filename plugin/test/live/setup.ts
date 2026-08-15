// Loads the sandbox credentials into the environment for the live suite.
//
// A missing file is not an error here: `liveConfig()` returns null and every group skips. The
// suite is opt-in, and "you have not deployed a sandbox" is a normal state, not a failure.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Every sandbox, not just the default: groups that reroot or re-key get their own Worker, and
// each credential file names its variables after its group.
const VAULT_DIR = path.resolve(import.meta.dirname, "../../../testvault");

let files: string[] = [];
try {
  files = readdirSync(VAULT_DIR).filter((n) => n === ".env.sandbox" || n.startsWith(".env.sandbox."));
} catch (error) {
  // Not deployed yet: `liveConfig()` returns null and every group skips. Opt-in, not broken.
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

for (const file of files) {
  for (const line of readFileSync(path.join(VAULT_DIR, file), "utf8").split("\n")) {
    const at = line.indexOf("=");
    if (at <= 0 || line.startsWith("#")) continue;
    // Never override a variable the caller set on purpose — that is how a single group gets
    // pointed somewhere else deliberately.
    process.env[line.slice(0, at).trim()] ??= line.slice(at + 1).trim();
  }
}
