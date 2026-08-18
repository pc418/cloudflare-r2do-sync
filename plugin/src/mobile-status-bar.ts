/**
 * Obsidian's status bar exists on mobile but is hidden by the app's own stylesheet, so
 * `addStatusBarItem()` succeeds there and then shows nobody anything. That is tolerable while
 * every pass announces itself, and not tolerable once notices can be turned off completely —
 * the whole argument for allowing silence is that the state is still readable somewhere.
 *
 * Making it readable is a CSS override plus one measurement: the mobile nav bar and toolbar are
 * absolutely positioned over the bottom of the app, so a status bar merely un-hidden sits
 * underneath them. The height has to be measured because it varies by device, by whether the
 * toolbar is showing, and by the safe-area inset on a notched phone.
 *
 * The measurement cannot be taken once. Obsidian adds and removes that bottom chrome as views
 * change, and the replacement arrives with no inline height until it has been laid out — hence
 * the observer, and hence the deferred re-measure rather than reading the height on the spot.
 *
 * The approach is the one the community settled on and `remotely-save` ships as an explicit
 * "experimental" toggle, which is why this is opt-in and reversible here too. It reaches past
 * the plugin API into Obsidian's own DOM, so it is the first thing to check if a future
 * Obsidian version moves the status bar — `describeFailure` exists to make that loud rather
 * than mysterious.
 */

/** How the controller reaches the document, so the policy above can be tested without a DOM. */
export interface MobileChromePort {
  /** Toggles the class the stylesheet keys the override on. */
  setEnabled(on: boolean): void;
  /**
   * Publishes the room the status bar must leave below itself, as a CSS length. `null` clears
   * it — the stylesheet falls back to zero rather than to a stale height from another layout.
   */
  setNavbarHeight(height: string | null): void;
  /** Measures the current bottom chrome, or `null` when none is in the DOM yet. */
  measureNavbarHeight(): string | null;
  /** Calls back when the app container's children change. Returns a disposer. */
  observeChrome(onChange: () => void): () => void;
}

/** What went wrong, or `null` when the override is live. Reported, never swallowed. */
export type MobileStatusBarFailure = "no-app-container" | "no-status-bar";

export interface MobileChromeLookup {
  /** `null` when Obsidian's DOM does not look the way this override expects. */
  port: MobileChromePort | null;
  failure: MobileStatusBarFailure | null;
}

/**
 * Milliseconds to wait before measuring replacement chrome.
 *
 * A `childList` mutation fires when the node is inserted, which is before layout has given it a
 * height — measuring on the spot reads 0 and the status bar lands under the nav bar. One frame
 * is not reliably enough on a slow phone, so this is a deliberately generous settle.
 */
export const CHROME_SETTLE_MS = 300;

/**
 * Keeps the mobile status bar visible and clear of the bottom chrome for as long as it is
 * enabled, and puts the DOM back exactly as it found it when it is not.
 */
export class MobileStatusBar {
  readonly #port: MobileChromePort;
  readonly #defer: (fn: () => void, ms: number) => () => void;

  #stopObserving: (() => void) | null = null;
  #cancelPending: (() => void) | null = null;

  constructor(
    port: MobileChromePort,
    /** Injected so a test can run the settle synchronously instead of waiting 300 ms. */
    defer: (fn: () => void, ms: number) => () => void = defaultDefer
  ) {
    this.#port = port;
    this.#defer = defer;
  }

  get enabled(): boolean {
    return this.#stopObserving !== null;
  }

  enable(): void {
    if (this.enabled) return;
    this.#port.setEnabled(true);
    // Measure what is already there before waiting for a mutation that may never come: the
    // ordinary case is enabling on a device whose nav bar has been in the DOM since startup.
    this.#port.setNavbarHeight(this.#port.measureNavbarHeight());
    this.#stopObserving = this.#port.observeChrome(() => this.#remeasureAfterSettle());
  }

  disable(): void {
    this.#cancelPending?.();
    this.#cancelPending = null;
    this.#stopObserving?.();
    this.#stopObserving = null;
    this.#port.setNavbarHeight(null);
    this.#port.setEnabled(false);
  }

  #remeasureAfterSettle(): void {
    // Chrome can be swapped several times in one view change; only the last measurement is
    // wanted, and an outstanding one would otherwise write a height for DOM that is already
    // gone. Cancelling also stops a settle from outliving `disable()`.
    this.#cancelPending?.();
    this.#cancelPending = this.#defer(() => {
      this.#cancelPending = null;
      if (!this.enabled) return;
      this.#port.setNavbarHeight(this.#port.measureNavbarHeight());
    }, CHROME_SETTLE_MS);
  }
}

function defaultDefer(fn: () => void, ms: number): () => void {
  const timer = window.setTimeout(fn, ms);
  return () => {
    window.clearTimeout(timer);
  };
}

/** Class the stylesheet keys the override on. Kept beside the CSS rule that reads it. */
export const MOBILE_STATUS_BAR_CLASS = "r2do-mobile-status-bar";
/** Custom property carrying the measured height into that rule. */
export const NAVBAR_HEIGHT_PROPERTY = "--r2do-mobile-navbar-height";

/** The bottom chrome, newest name first — Obsidian has shipped both. */
const CHROME_SELECTORS = [".mobile-navbar", ".mobile-toolbar"] as const;

/**
 * Whether a node is one this override can style.
 *
 * A capability check rather than `instanceof HTMLElement`: an element belonging to another
 * realm fails `instanceof` while being perfectly stylable, and this narrows to exactly the two
 * members used below rather than asserting a whole interface that is never verified.
 */
function isStylable(node: Element | null): node is HTMLElement {
  return node !== null && "style" in node;
}

/**
 * Binds the controller to a real document. Everything Obsidian-shaped lives here, so the
 * controller above stays a policy object with no DOM in it.
 */
export function domMobileChrome(doc: Document): MobileChromeLookup {
  const container = doc.querySelector(".app-container");
  if (container === null) return { port: null, failure: "no-app-container" };
  const statusBar = doc.querySelector(".app-container .status-bar");
  if (!isStylable(statusBar)) return { port: null, failure: "no-status-bar" };

  const port: MobileChromePort = {
    setEnabled(on) {
      doc.body.classList.toggle(MOBILE_STATUS_BAR_CLASS, on);
    },
    setNavbarHeight(height) {
      if (height === null) statusBar.style.removeProperty(NAVBAR_HEIGHT_PROPERTY);
      else statusBar.style.setProperty(NAVBAR_HEIGHT_PROPERTY, height);
    },
    measureNavbarHeight() {
      for (const selector of CHROME_SELECTORS) {
        const chrome = doc.querySelector(selector);
        if (!isStylable(chrome)) continue;
        const height = window.getComputedStyle(chrome).getPropertyValue("height");
        // A node inserted but not yet laid out measures "0px" or "auto"; both would pin the
        // status bar under the nav bar, so neither is worth recording.
        if (height !== "" && height !== "auto" && height !== "0px") return height;
      }
      return null;
    },
    observeChrome(onChange) {
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type !== "childList") continue;
          if (mutation.addedNodes.length === 0 && mutation.removedNodes.length === 0) continue;
          onChange();
          return;
        }
      });
      observer.observe(container, { childList: true, subtree: false });
      return () => {
        observer.disconnect();
      };
    },
  };
  return { port, failure: null };
}

/** Why the override could not be installed, in words a user can act on. */
export function describeFailure(failure: MobileStatusBarFailure): string {
  return failure === "no-app-container"
    ? "Obsidian's app container was not found, so the status bar could not be shown."
    : "Obsidian's status bar element was not found, so it could not be shown. This override " +
        "reaches into Obsidian's own layout, and a new Obsidian version may have changed it.";
}
