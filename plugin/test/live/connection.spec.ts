// Group 1 — Connection. Also the harness's own smoke test: if these fail, no other live
// group means anything, because the failure is the plumbing rather than the plugin.
import { afterEach, describe, expect, it } from "vitest";
import { LiveHarness, liveConfig } from "./harness";

const config = liveConfig("connection");

describe.skipIf(config === null)("Connection", () => {
  let harness: LiveHarness | null = null;
  afterEach(async () => {
    await harness?.dispose();
    harness = null;
  });

  it("renders the nine sections against a real deployment", async () => {
    harness = await LiveHarness.start(config!);
    const log = harness.render();
    expect(log.headings).toEqual([
      "Connection",
      "This device",
      "Encryption",
      "What syncs",
      "How and when it syncs",
      "Conflicts",
      "Safety and recovery",
      "Notices",
      "Troubleshooting",
    ]);
  });

  it("Test reports a reachable Worker, and says so out loud", async () => {
    harness = await LiveHarness.start(config!);
    harness.render();
    const before = harness.http.calls;

    await harness.button("Test connection").click();

    // A real request left the process — not a stub answering in zero round trips.
    expect(harness.http.calls).toBeGreaterThan(before);
    expect(harness.notices().at(-1)).toMatch(/connected|reachable|ok/i);
  });

  it("Test reports a bad token as a failure instead of a success", async () => {
    harness = await LiveHarness.start(config!, {
      persisted: { settings: { accessToken: "0".repeat(64) } },
    });
    harness.render();

    await harness.button("Test connection").click();

    const notice = harness.notices().at(-1) ?? "";
    expect(notice).not.toMatch(/connected|reachable/i);
    expect(notice).toMatch(/401|unauthor|token/i);
  });

  it("a Server URL that is not a URL is refused before it is stored", async () => {
    harness = await LiveHarness.start(config!);
    harness.render();
    const field = harness.row("Server URL").texts[0];

    field.change("not-a-url");
    field.inputEl.fire("blur");

    expect(harness.plugin.settings.serverUrl).toBe(config!.url);
  });
});
