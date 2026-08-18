import { describe, it, expect } from "vitest";
import { CHROME_SETTLE_MS, MobileStatusBar, type MobileChromePort } from "../src/mobile-status-bar";

/**
 * A port that records what the controller asked the DOM to do, plus a hand-cranked settle so
 * the 300 ms wait is exercised without a timer. `defer` returns its canceller, which is the
 * part worth testing: a measurement left in flight would write a height for chrome that is
 * gone, or for a controller that has been switched off.
 */
function harness(navbarHeight: string | null = "48px") {
  const calls: string[] = [];
  let observer: (() => void) | null = null;
  const pending: Array<{ fn: () => void; cancelled: boolean }> = [];
  const port: MobileChromePort = {
    setEnabled(on) {
      calls.push(on ? "enable" : "disable");
    },
    setNavbarHeight(height) {
      calls.push(`height:${height ?? "cleared"}`);
    },
    measureNavbarHeight() {
      calls.push("measure");
      return navbarHeight;
    },
    observeChrome(onChange) {
      observer = onChange;
      calls.push("observe");
      return () => {
        observer = null;
        calls.push("unobserve");
      };
    },
  };
  const defer = (fn: () => void, ms: number): (() => void) => {
    expect(ms).toBe(CHROME_SETTLE_MS);
    const entry = { fn, cancelled: false };
    pending.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  return {
    calls,
    bar: new MobileStatusBar(port, defer),
    /** Obsidian swapped the bottom chrome. */
    chromeChanged: () => observer?.(),
    /** Let every outstanding settle run, as the timer would. */
    settle: () => {
      for (const entry of pending.splice(0)) if (!entry.cancelled) entry.fn();
    },
    observing: () => observer !== null,
    setHeight: (h: string | null) => {
      navbarHeight = h;
    },
  };
}

describe("MobileStatusBar", () => {
  it("shows the bar and measures what is already on screen, without waiting for a mutation", () => {
    // The ordinary case is switching this on while the nav bar has been in the DOM since
    // startup, so a controller that only measured on mutation would leave the bar hidden
    // under the nav bar until the user happened to change view.
    const h = harness("48px");
    h.bar.enable();
    expect(h.calls).toEqual(["enable", "measure", "height:48px", "observe"]);
    expect(h.bar.enabled).toBe(true);
  });

  it("re-measures after the settle when Obsidian swaps the bottom chrome", () => {
    const h = harness("48px");
    h.bar.enable();
    h.calls.length = 0;
    h.setHeight("64px");
    h.chromeChanged();
    // Nothing yet: a node is measured as 0 the instant it is inserted, before layout.
    expect(h.calls).toEqual([]);
    h.settle();
    expect(h.calls).toEqual(["measure", "height:64px"]);
  });

  it("keeps only the last measurement when the chrome changes several times", () => {
    // One view change can add and remove chrome repeatedly; each outstanding settle would
    // otherwise write a height for a layout that has already been replaced.
    const h = harness("48px");
    h.bar.enable();
    h.calls.length = 0;
    h.chromeChanged();
    h.chromeChanged();
    h.chromeChanged();
    h.setHeight("72px");
    h.settle();
    expect(h.calls).toEqual(["measure", "height:72px"]);
  });

  it("puts the DOM back exactly as it found it", () => {
    const h = harness();
    h.bar.enable();
    h.calls.length = 0;
    h.bar.disable();
    // Height cleared BEFORE the class comes off, so no frame renders the bar with a stale
    // margin; and the observer is disconnected, or it would outlive the plugin.
    expect(h.calls).toEqual(["unobserve", "height:cleared", "disable"]);
    expect(h.bar.enabled).toBe(false);
    expect(h.observing()).toBe(false);
  });

  it("does not measure after being switched off", () => {
    // A settle scheduled just before `disable()` would otherwise re-apply a height to a status
    // bar the user has already put back, leaving an override nothing switches off.
    const h = harness();
    h.bar.enable();
    h.chromeChanged();
    h.calls.length = 0;
    h.bar.disable();
    h.settle();
    expect(h.calls).toEqual(["unobserve", "height:cleared", "disable"]);
  });

  it("is idempotent, so a redundant enable does not stack a second observer", () => {
    const h = harness();
    h.bar.enable();
    h.calls.length = 0;
    h.bar.enable();
    expect(h.calls).toEqual([]);
  });

  it("tolerates chrome it cannot measure rather than writing a bogus height", () => {
    // `null` clears the property so the stylesheet falls back to zero. A stale height from a
    // previous layout would be worse than none: it reserves space for chrome that is gone.
    const h = harness(null);
    h.bar.enable();
    expect(h.calls).toEqual(["enable", "measure", "height:cleared", "observe"]);
  });
});
