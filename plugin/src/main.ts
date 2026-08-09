import {
  App,
  Modal,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TFolder,
  requestUrl,
  setIcon,
  type Vault,
} from "obsidian";
import qrcode from "qrcode-generator";
import { SyncApi, type HttpClient } from "./api";
import {
  VaultCrypto,
  deriveMasterKeyFromPassphrase,
  generateMasterKey,
  generateVaultSalt,
  parseMasterKey,
  parseVaultSalt,
} from "./crypto";
import {
  activateEncryptionState,
  encryptionReadiness,
  normalizeEncryptionState,
  remoteManifestMatchesTarget,
  type EncryptionMode,
} from "./encryption-state";
import {
  conflictDiff,
  isResolvable,
  latestSide,
  planResolutionOnDisk,
  type ConflictChoice,
} from "./conflict-resolve";
import { allHotkeys, assignHotkey, boundHotkeys, openHotkeySettings } from "./hotkey-bridge";
import {
  SUGGESTED_SYNC_HOTKEY,
  findBindingConflicts,
  formatBindings,
  formatHotkey,
} from "./hotkeys";
import { ObsidianVault } from "./obsidian-vault";
import {
  SyncEngine,
  type ConflictInfo,
  type MassChangeDecision,
  type MassChangeSummary,
  type SnapshotInfo,
  type SyncPreview,
  type SyncResult,
} from "./sync";
import { decodeText, type ConflictMode } from "./merge";
import {
  LOG_ENTRIES_RANGE,
  MAX_LOG_ENTRIES,
  appendLog,
  entryFromError,
  entryFromResult,
  formatLogNote,
  relativeTime,
  announcePass,
  describePass,
  passChangedSomething,
  type SyncLogEntry,
} from "./log";
import { countInScope, parseGlobs } from "./paths";
import { DEFAULT_LANES, MAX_LANES, clampLanes } from "./pool";
import { SyncScheduler } from "./queue";
import {
  SETUP_ACTION,
  decodeSetupPayload,
  encodeSetupPayload,
  encodeSetupUri,
  normalizeServerUrl,
  parseSetupText,
  type SetupPayload,
} from "./setup-link";
import {
  applySharedSettings,
  extractSharedSettings,
  isNewerRev,
  isSettingsDoc,
  reconcileVaultSalt,
  sharedFingerprint,
  type SettingsDoc,
  type SettingsRev,
} from "./settings-doc";
import type { StateStore, SyncState } from "./types";
import type { SyncMode } from "./sync-policy";

export interface Settings {
  serverUrl: string;
  accessToken: string;
  deviceName: string;
  /** Base64 vault master key. Non-empty means end-to-end encryption is on. */
  masterKey: string;
  /** Explicit mode: an empty key is never interpreted as consent to upload plaintext. */
  encryptionMode: EncryptionMode;
  /** Encrypted sync stays disabled until the operator confirms the key was backed up. */
  masterKeyBackedUp: boolean;
  /** Public PBKDF2 salt shared by the vault; not a secret and never a passphrase. */
  vaultSalt: string;
  excludes: string;
  /** Empty means whole vault; otherwise only matching paths are tracked by this device. */
  onlyPaths: string;
  syncMode: SyncMode;
  /** Opt-in `.obsidian/**` scanning; the plugin's own directory remains hard-excluded. */
  syncConfigDir: boolean;
  debounceSeconds: number;
  intervalMinutes: number;
  syncOnStartup: boolean;
  maxBlobMB: number;
  /** Share of the vault a pull may delete or overwrite before asking. 100 disables. */
  protectPercent: number;
  /** Unmergeable pairs: park the loser as a copy, or let newest/largest overwrite. */
  conflictMode: ConflictMode;
  /** Files handled at once per phase. Device-local: a phone wants fewer than a desktop. */
  lanes: number;
  /** Passes kept in the log. Larger means a longer trail and a larger `data.json`. */
  logEntries: number;
  /** Snapshots the history browser lists — each one is a manifest fetch. */
  historyLimit: number;
  /** Automatic retries after a failed pass, before it is reported and left alone. */
  retryAttempts: number;
  /** Folder the exported report is written to. Empty means the vault root. */
  logNoteFolder: string;
  /** Notice when a pass finishes — the only status a phone can show. */
  notifyOnSync: boolean;
  /**
   * Narrow those notices to passes that actually moved a file. Off by default: a sync that
   * found nothing to do is still evidence the plugin is alive and reaching the server.
   */
  notifyOnlyChanged: boolean;
  /** List the changed files in the notice, not just how many files and lines moved. */
  verboseSyncNotice: boolean;
  /** Share vault-wide settings (excludes, thresholds, intervals, …) between devices. */
  syncSettings: boolean;
  /**
   * One-time per-device consent to the first sync. The first pass on a fresh device
   * reconciles two vaults that both already hold real files; the key-backup gate protects
   * the key, and the mass-change guard only fires *during* a pass. Device-local, because
   * each device reconciles its own copy exactly once.
   */
  firstSyncAcknowledged: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  serverUrl: "",
  accessToken: "",
  deviceName: "device",
  masterKey: "",
  encryptionMode: "encrypted",
  masterKeyBackedUp: false,
  vaultSalt: "",
  excludes: ".trash/**",
  onlyPaths: "",
  syncMode: "two-way",
  syncConfigDir: false,
  debounceSeconds: 3,
  intervalMinutes: 15,
  syncOnStartup: true,
  maxBlobMB: 90,
  protectPercent: 50,
  conflictMode: "keep-both",
  lanes: DEFAULT_LANES,
  logEntries: MAX_LOG_ENTRIES,
  historyLimit: 40,
  retryAttempts: 3,
  logNoteFolder: "",
  // On by default: mobile has no status bar, so without this a tap on the ribbon that
  // succeeds with nothing to do looks identical to one that never ran.
  notifyOnSync: true,
  notifyOnlyChanged: false,
  verboseSyncNotice: false,
  syncSettings: true,
  firstSyncAcknowledged: false,
};

/**
 * Whether this device still owes the one-time "back up the vault first" acknowledgement.
 * A device that already holds a synced snapshot has nothing left to warn about: its first
 * reconciliation happened, whether or not this gate existed at the time.
 */
export function needsFirstSyncConsent(opts: {
  acknowledged: boolean;
  hasSyncedSnapshot: boolean;
}): boolean {
  return !opts.acknowledged && !opts.hasSyncedSnapshot;
}

/**
 * The thing a self-hosted sync plugin owes the user in plain words. Shown twice on purpose:
 * as prose on the first-run panel, where it can still change someone's mind about installing
 * this at all, and inside the first-sync gate, where it is answered rather than merely read.
 *
 * It takes the mode because the confidentiality half is only true in one of them. A fixed
 * string promising the server cannot read anything is not a harmless simplification on a
 * plaintext vault — it is a false assurance, made mandatory, moments before the notes are
 * uploaded in the clear. Plaintext devices reach this dialog: `encryptionEnabled` is nothing
 * but the mode, the gate has no mode guard, and `applySetup` copies the mode from the link.
 */
export function dataResponsibility(mode: EncryptionMode): string {
  const shared =
    "Keeping your own backups is yours to do, and nobody else can do it for you: there is " +
    "no operator and no support channel behind this plugin. It is provided as-is, without " +
    "warranty of any kind.";
  return mode === "encrypted"
    ? "R2DO Sync is self-hosted. Your notes live in storage you own and pay for, encrypted " +
        "on this device under a master key that only you hold, so nobody else can read them " +
        `or recover them for you. ${shared} Lose the key and every encrypted snapshot is ` +
        "permanently unreadable."
    : "R2DO Sync is self-hosted, and encryption is turned OFF for this vault. Your notes " +
        "and their file paths are uploaded exactly as they are, so anyone who can read the " +
        "storage bucket — your provider, and anyone holding its credentials — can read " +
        `them. ${shared}`;
}

/**
 * The one-time first-sync gate, one paragraph per entry. Exported as data so a test can prove
 * the disclaimer is actually in the dialog the user has to answer, rather than only in the
 * panel they may never look at.
 */
export function firstSyncConsentBody(mode: EncryptionMode): readonly string[] {
  return [
    "This device has not synced with the vault yet, so the first pass reconciles two " +
      "collections of real files: everything the remote holds is merged into this vault, and " +
      "everything here is published. Notes that cannot be merged are kept on both sides, but " +
      "a copy of this vault is the only thing that makes a bad first pass fully undoable. " +
      "Make one now if you have not.",
    dataResponsibility(mode),
  ];
}

/**
 * No server URL or no access token means no engine can be built. The settings tab and
 * `#finishRebuild` share this so the page and the engine can never disagree about whether
 * this device is set up — a page claiming otherwise would send the user looking for a bug.
 */
export function isUnconfigured(s: Pick<Settings, "serverUrl" | "accessToken">): boolean {
  return s.serverUrl.trim() === "" || s.accessToken.trim() === "";
}

/** Backoff between automatic retries. `retryAttempts` takes the first N. */
const RETRY_DELAYS_MS = [1000, 4000, 15_000, 60_000, 300_000];

export const MAX_RETRY_ATTEMPTS = RETRY_DELAYS_MS.length;

interface PersistedData {
  settings: Settings;
  state: SyncState | null;
  /** Endpoint whose manifest head/file cache the state belongs to. */
  stateServerUrl?: string;
  /** Recent passes, newest first — the answer to "when did it stop working?". */
  log?: SyncLogEntry[];
  lastSuccessAt?: number;
  lastFailureAt?: number;
  /** Last shared-settings doc this device agreed with (applied or published). */
  sharedSettings?: { rev: SettingsRev; fingerprint: string } | null;
  /** Conflicts from the most recent pass that had any, for the review command. */
  lastConflicts?: ConflictInfo[];
  /** Crash-resumable target while the remote snapshot is transformed under a new mode/key. */
  pendingEncryptionTransition?: PendingEncryptionTransition | null;
}

interface PendingEncryptionTransition {
  mode: EncryptionMode;
  key: string;
  backedUp: boolean;
  vaultSalt: string;
}

/** Where a user with no clone can read the setup instructions the first-run panel names. */
const REPO_URL = "https://github.com/pc418/cloudflare-r2do-sync#readme";

/** How often the status bar re-renders so "synced 3m ago" keeps counting up. */
const STATUS_REFRESH_MS = 30_000;

/**
 * The command a hotkey is worth having. Named once because the hotkey manager keys bindings by
 * the *qualified* id (`<plugin id>:sync-now`), so a rename here would silently orphan a binding.
 */
const SYNC_COMMAND = "sync-now";

/**
 * The one shared-settings failure with a specific cure: this device holds a key the vault
 * does not know. Distinguished from every other cause so the settings tab can offer the fix
 * (import the key from a working device) instead of only reporting the symptom.
 */
class WrongVaultKeyError extends Error {}

/** Obsidian's requestUrl bypasses CORS, which plain fetch cannot do on mobile. */
const obsidianHttp: HttpClient = async (url, req) => {
  const res = await requestUrl({
    url,
    method: req.method,
    headers: req.headers,
    body: req.body,
    throw: false,
  });
  return {
    status: res.status,
    text: async () => res.text,
    json: async () => res.json,
    arrayBuffer: async () => res.arrayBuffer,
  };
};

export default class LogSyncPlugin extends Plugin {
  settings: Settings = { ...DEFAULT_SETTINGS };
  #state: SyncState | null = null;
  #scheduler: SyncScheduler | null = null;
  #engine: SyncEngine | null = null;
  #generation = 0;
  #schedulerDrain: Promise<void> = Promise.resolve();
  #persistChain: Promise<void> = Promise.resolve();
  #stateServerUrl = "";
  #statusBar: HTMLElement | null = null;
  #ribbon: HTMLElement | null = null;
  /** The live periodic-sync timer and the interval it was built from, so a change can replace it. */
  #autoSyncTimer: number | null = null;
  #autoSyncMinutes = 0;

  #log: SyncLogEntry[] = [];
  #lastSuccessAt: number | undefined;
  #lastFailureAt: number | undefined;
  #sharedSettings: { rev: SettingsRev; fingerprint: string } | null = null;
  #settingsPushTimer: number | null = null;
  #lastConflicts: ConflictInfo[] = [];
  #pendingEncryptionTransition: PendingEncryptionTransition | null = null;
  #backupModalOpen = false;
  #firstSyncModalOpen = false;
  /**
   * Why this device is rejected by the vault when the cause is a wrong master key, which is
   * the one sync failure with a specific cure (import the key from a working device). Held in
   * memory only: it is a fact about the remote, so it is re-established by the next pass
   * rather than restored from disk where it could go stale.
   */
  #keyMismatch: string | null = null;
  /** Set while a sync the user asked for is running, so guards may raise a modal. */
  #interactive = 0;
  #phase:
    | "idle"
    | "syncing"
    | "halted"
    | "decision"
    | "unconfigured"
    | "backup-required"
    | "first-sync" = "idle";
  #progress: string | null = null;

  async onload(): Promise<void> {
    const data = (await this.loadData()) as PersistedData | null;
    const savedSettings = data?.settings ?? null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(savedSettings ?? {}),
      ...normalizeEncryptionState(savedSettings),
    };
    // Exact legacy default only: config-directory gating is now a dedicated confirmed
    // toggle. Preserve every custom exclude list verbatim.
    if (this.settings.excludes === ".obsidian/**\n.trash/**") {
      this.settings.excludes = ".trash/**";
    }
    this.#stateServerUrl = endpointIdentity(this.settings.serverUrl);
    const persistedStateServerUrl = endpointIdentity(
      data?.stateServerUrl ?? data?.settings?.serverUrl ?? this.settings.serverUrl
    );
    const sameEndpoint = persistedStateServerUrl === this.#stateServerUrl;
    this.#state = sameEndpoint ? (data?.state ?? null) : null;
    // A hand-edited `data.json` can point this device at a different vault between loads.
    // Dropping the cached head without dropping the consent leaves the flag alone to
    // suppress the gate, so the first pass against a stranger's files happens unwarned.
    if (!sameEndpoint) this.settings.firstSyncAcknowledged = false;
    this.#log = data?.log ?? [];
    this.#lastSuccessAt = data?.lastSuccessAt;
    this.#lastFailureAt = data?.lastFailureAt;
    this.#sharedSettings = sameEndpoint ? (data?.sharedSettings ?? null) : null;
    this.#lastConflicts = data?.lastConflicts ?? [];
    this.#pendingEncryptionTransition = data?.pendingEncryptionTransition ?? null;

    // The status bar does not exist on mobile, so the ribbon is the only always-present
    // affordance a phone has: it both starts a sync and carries the status in its tooltip.
    this.#ribbon = this.addRibbonIcon("refresh-cw", "R2DO Sync: sync now", () => void this.syncNow());
    this.#statusBar = this.addStatusBarItem();
    this.#statusBar.onClickEvent(() => void this.syncNow());
    this.#renderStatus();
    // Keeps the relative time honest without a sync having to happen.
    this.registerInterval(window.setInterval(() => this.#renderStatus(), STATUS_REFRESH_MS));

    this.addSettingTab(new LogSyncSettingTab(this.app, this));

    this.addCommand({
      // No `hotkeys:` here on purpose — see hotkeys.ts. The settings tab offers a binding.
      id: SYNC_COMMAND,
      name: "Sync now",
      callback: () => void this.syncNow(),
    });
    this.addCommand({
      id: "sync-preview",
      name: "Preview sync (dry run)",
      callback: () => void this.previewSync(),
    });
    this.addCommand({
      id: "sync-history",
      name: "Browse snapshot history",
      callback: () => void this.openHistory(),
    });
    this.addCommand({
      id: "sync-export-log",
      name: "Export sync log to a note",
      callback: () => void this.exportLog(),
    });
    this.addCommand({
      id: "sync-review-conflicts",
      name: "Review and resolve conflicts",
      callback: () => {
        if (this.#lastConflicts.length === 0) {
          new Notice("R2DO Sync: no conflicts recorded");
          return;
        }
        this.openConflictReview(this.#lastConflicts);
      },
    });
    this.addCommand({
      id: "sync-reset",
      name: "Clear halted state and retry",
      callback: () => {
        this.#engine?.reset();
        new Notice("R2DO Sync: halt cleared, retrying");
        void this.syncNow();
      },
    });
    this.addCommand({
      // The id outlives the label on purpose: renaming it would silently drop any hotkey a
      // user has already bound to this command.
      id: "sync-setup-qr",
      name: "Set up another device",
      callback: () => new DeviceSetupModal(this.app, this).open(),
    });
    this.addCommand({
      id: "sync-apply-setup-link",
      name: "Apply a setup link (paste)",
      callback: () => new PasteSetupModal(this.app, this).open(),
    });

    // The phone's own camera app opens this URI, so no scanner ships in the plugin.
    this.registerObsidianProtocolHandler(SETUP_ACTION, (params) => {
      try {
        const payload = decodeSetupPayload(params.d);
        new ApplySetupModal(this.app, this, payload).open();
      } catch (e) {
        new Notice(`R2DO Sync setup link rejected: ${message(e)}`, 10_000);
      }
    });

    await this.rebuild();
    if (this.#pendingEncryptionTransition !== null) {
      await this.#resumeEncryptionTransition();
    }

    const onChange = () => {
      // While a decision is pending, an automatic pass would re-run the whole plan and
      // silently re-park it. Manual syncs still work — that is how the user answers.
      if (this.#phase === "decision") return;
      this.#scheduler?.notifyChange();
    };
    this.registerEvent(this.app.vault.on("create", onChange));
    this.registerEvent(this.app.vault.on("modify", onChange));
    this.registerEvent(this.app.vault.on("delete", onChange));
    this.registerEvent(this.app.vault.on("rename", onChange));

    this.#restartAutoSyncTimer();

    if (this.settings.syncOnStartup) {
      this.app.workspace.onLayoutReady(() => void this.#autoSync());
    }

    // A phone rarely cold-starts Obsidian — the OS suspends and RESUMES it, so
    // `onLayoutReady` never re-fires and the interval timer slept the whole time.
    // Becoming visible again is mobile's equivalent of startup.
    if (Platform.isMobile) {
      this.registerDomEvent(document, "visibilitychange", () => {
        if (document.visibilityState !== "visible" || !this.settings.syncOnStartup) return;
        const gapMinutes = this.settings.intervalMinutes > 0 ? this.settings.intervalMinutes : 15;
        const lastPassAt = Math.max(this.#lastSuccessAt ?? 0, this.#lastFailureAt ?? 0);
        if (Date.now() - lastPassAt < gapMinutes * 60_000) return;
        void this.#autoSync();
      });
    }
  }

  /**
   * Rebuilds the periodic-sync timer when its interval changes.
   *
   * The timer used to be registered once during `onload`, so a new interval only took effect
   * after restarting Obsidian — a settings change that does nothing until the app is restarted
   * is indistinguishable from one that did not save. Rebuilt only on an actual change, so the
   * unrelated saves that `saveSettings` performs do not keep resetting the countdown.
   */
  #restartAutoSyncTimer(): void {
    if (this.settings.intervalMinutes === this.#autoSyncMinutes) return;
    if (this.#autoSyncTimer !== null) {
      window.clearInterval(this.#autoSyncTimer);
      this.#autoSyncTimer = null;
    }
    this.#autoSyncMinutes = this.settings.intervalMinutes;
    if (this.#autoSyncMinutes <= 0) return;
    this.#autoSyncTimer = window.setInterval(
      () => void this.#autoSync(),
      this.#autoSyncMinutes * 60_000
    );
    // Registered as well as tracked: `onunload` clears the current one, and this is the
    // platform's own guarantee that no timer of ours outlives the plugin.
    this.registerInterval(this.#autoSyncTimer);
  }

  /**
   * A pass nobody asked for: a timer or startup. Never raises a modal, because there may be
   * no one at the keyboard to answer it — a pending decision surfaces in the status bar and
   * a notice instead, and waits for a manual sync.
   */
  async #autoSync(): Promise<void> {
    if (!this.#scheduler || this.#phase === "decision") return;
    // The first-sync gate needs an answer, and an unattended pass has nobody to give one.
    if (
      needsFirstSyncConsent({
        acknowledged: this.settings.firstSyncAcknowledged,
        hasSyncedSnapshot: this.hasSyncedSnapshot,
      })
    ) {
      return;
    }
    try {
      await this.#syncSharedSettings();
    } catch (e) {
      // No one is watching an unattended pass; a manual sync surfaces the same failure.
      console.error("R2DO Sync: shared settings check failed", e);
    }
    if (!this.#scheduler) return; // an applied settings doc rebuilt into "unconfigured"
    try {
      await this.#scheduler.syncNow();
    } catch {
      // reported through onError
    }
  }

  onunload(): void {
    if (this.#settingsPushTimer !== null) window.clearTimeout(this.#settingsPushTimer);
    if (this.#autoSyncTimer !== null) window.clearInterval(this.#autoSyncTimer);
    this.#retireScheduler();
  }

  // --- shared settings document --------------------------------------------------------
  //
  // Vault-wide settings (the SharedSettings subset) live in one encrypted document on the
  // server; every device pulls it before a pass and publishes when its own copy changes.
  // Everything here runs OUTSIDE an engine pass on purpose: applying a doc goes through
  // saveSettings, which retires the scheduler — from inside a running pass that would
  // deadlock waiting on the very pass that called it.

  #settingsApi(): SyncApi | null {
    if (!this.settings.syncSettings) return null;
    if (!this.settings.serverUrl || !this.settings.accessToken) return null;
    if (encryptionReadiness(this.settings) !== "ready") return null;
    try {
      return new SyncApi({
        baseUrl: this.settings.serverUrl,
        token: this.settings.accessToken,
        http: obsidianHttp,
      });
    } catch {
      return null; // invalid URL — the engine rebuild already told the user
    }
  }

  get keyMismatch(): string | null {
    return this.#keyMismatch;
  }

  /** Pull a newer document if there is one, then publish unpublished local changes. */
  async #syncSharedSettings(): Promise<void> {
    try {
      await this.#pullSharedSettings();
    } catch (e) {
      if (e instanceof WrongVaultKeyError) this.#keyMismatch = e.message;
      throw e;
    }
    await this.#pushSharedSettings();
  }

  async #pullSharedSettings(): Promise<void> {
    const api = this.#settingsApi();
    if (api === null) return;
    const raw = await api.getSettingsDoc();
    if (raw === null) return; // nothing shared yet; a local change will publish first
    if (!isSettingsDoc(raw)) throw new Error("shared settings document is malformed");
    const salt = reconcileVaultSalt(this.settings.vaultSalt, raw.vaultSalt);
    const saltChanged = salt.changed;
    if (salt.changed) {
      this.settings.vaultSalt = salt.salt;
      if (salt.replaced !== null) {
        // Only worth a word: a passphrase-derived key was derived with the old salt, so the
        // owner's written-down recovery pair no longer matches the vault.
        new Notice(
          "R2DO Sync adopted this vault's published salt in place of the one this device " +
            "generated. If you set this device's master key from a passphrase, re-derive it " +
            "using the vault salt now shown in settings.",
          15_000
        );
      }
    }
    const rev: SettingsRev = { updatedAt: raw.updatedAt, device: raw.device };
    if (this.#sharedSettings !== null && !isNewerRev(rev, this.#sharedSettings.rev)) {
      if (saltChanged) await this.#persist();
      return;
    }

    let plain: Record<string, unknown>;
    if (raw.v === 2) {
      if (!this.encryptionEnabled) {
        throw new Error("shared settings are encrypted, but this device has no master key");
      }
      const crypto = await VaultCrypto.fromText(this.settings.masterKey);
      if (crypto.keyId !== raw.keyId) {
        throw new WrongVaultKeyError(
          "shared settings were written with a different master key — this device was " +
            'configured by hand instead of from the vault. On a working device use "Set up ' +
            'another device", then scan its QR or copy its setup link and apply that here; ' +
            "a typed server URL and access token do not carry the key."
        );
      }
      // Positive proof this device holds the vault's key, so any earlier verdict is stale.
      this.#keyMismatch = null;
      plain = await crypto.decryptSettingsJson<Record<string, unknown>>(raw.enc);
    } else {
      // Mixed mode also halts the vault sync itself; refusing here keeps the two aligned.
      if (this.encryptionEnabled) {
        throw new Error("shared settings are plaintext, but this vault is encrypted");
      }
      plain = raw.plain;
    }

    const changed = applySharedSettings(this.settings, plain) || saltChanged;
    this.#sharedSettings = { rev, fingerprint: sharedFingerprint(this.settings) };
    if (changed) {
      // Fingerprint already matches the doc, so the push scheduled by saveSettings no-ops.
      await this.saveSettings();
      new Notice(`R2DO Sync: settings updated from "${rev.device}"`, 5000);
    } else {
      await this.#persist();
    }
  }

  async #pushSharedSettings(): Promise<void> {
    const api = this.#settingsApi();
    if (api === null) return;
    const fingerprint = sharedFingerprint(this.settings);
    if (this.#sharedSettings?.fingerprint === fingerprint) return;

    const rev: SettingsRev = { updatedAt: Date.now(), device: this.settings.deviceName };
    const shared = { ...extractSharedSettings(this.settings) } as Record<string, unknown>;
    const vaultSalt = this.settings.vaultSalt === "" ? {} : { vaultSalt: this.settings.vaultSalt };
    let doc: SettingsDoc;
    if (this.encryptionEnabled) {
      const crypto = await VaultCrypto.fromText(this.settings.masterKey);
      doc = {
        v: 2,
        ...rev,
        ...vaultSalt,
        keyId: crypto.keyId,
        enc: await crypto.encryptSettingsJson(shared),
      };
    } else {
      doc = { v: 1, ...rev, ...vaultSalt, plain: shared };
    }
    await api.putSettingsDoc(doc);
    this.#sharedSettings = { rev, fingerprint };
    await this.#persist();
  }

  /**
   * Publish shortly after a settings edit. Debounced because text controls fire per
   * keystroke; failures surface as a notice — the next pass retries via the fingerprint.
   */
  #schedulePushSharedSettings(): void {
    if (this.#settingsApi() === null) return;
    if (this.#sharedSettings?.fingerprint === sharedFingerprint(this.settings)) return;
    if (this.#settingsPushTimer !== null) window.clearTimeout(this.#settingsPushTimer);
    this.#settingsPushTimer = window.setTimeout(() => {
      this.#settingsPushTimer = null;
      this.#pushSharedSettings().catch((e) => {
        new Notice(`R2DO Sync: could not publish settings to other devices: ${message(e)}`, 10_000);
      });
    }, 2000);
  }

  get encryptionEnabled(): boolean {
    return this.settings.encryptionMode === "encrypted";
  }

  get hasSyncedSnapshot(): boolean {
    return this.#state?.lastSyncedHead != null;
  }

  /** Rebuilds the engine/scheduler after a settings change. */
  async rebuild(): Promise<void> {
    const generation = this.#retireScheduler();
    await this.#finishRebuild(generation);
  }

  /** Invalidates callbacks immediately and adds any active pass to the replacement barrier. */
  #retireScheduler(): number {
    const generation = ++this.#generation;
    const retiring = this.#scheduler;
    this.#engine = null;
    this.#scheduler = null;
    if (retiring) {
      const previousDrain = this.#schedulerDrain;
      this.#schedulerDrain = Promise.all([previousDrain, retiring.stopAndWait()]).then(() => {});
    }
    return generation;
  }

  async #finishRebuild(generation: number): Promise<void> {
    await this.#schedulerDrain;
    if (generation !== this.#generation) return;

    if (isUnconfigured(this.settings)) {
      this.#phase = "unconfigured";
      this.#renderStatus();
      return;
    }

    let readiness = encryptionReadiness(this.settings);
    if (readiness === "key-required") {
      // Fresh hand configuration: create the key before any engine exists, persist it, and
      // keep sync blocked until the one-time backup gate is explicitly acknowledged.
      this.settings.masterKey = generateMasterKey();
      this.settings.masterKeyBackedUp = false;
      if (this.settings.vaultSalt === "") this.settings.vaultSalt = generateVaultSalt();
      await this.#persist();
      readiness = "backup-required";
    }
    if (readiness === "backup-required") {
      this.#phase = "backup-required";
      this.#renderStatus();
      this.#promptBackupKey();
      return;
    }
    if (readiness === "plaintext-key-conflict") {
      this.#phase = "halted";
      this.#renderStatus();
      new Notice("R2DO Sync disabled: plaintext mode still has a master key; finish or cancel the encryption change", 0);
      return;
    }

    let serverUrl: string;
    try {
      serverUrl = normalizeServerUrl(this.settings.serverUrl);
    } catch (e) {
      this.#phase = "halted";
      this.#renderStatus();
      new Notice(`R2DO Sync disabled: ${message(e)}`, 0);
      return;
    }

    // A bad key must never silently degrade into uploading plaintext, so refuse to run.
    let crypto: VaultCrypto | null = null;
    if (this.encryptionEnabled) {
      try {
        crypto = await VaultCrypto.fromText(this.settings.masterKey);
      } catch (e) {
        this.#phase = "halted";
        this.#renderStatus();
        new Notice(`R2DO Sync disabled: ${message(e)}`, 0);
        return;
      }
    }
    if (generation !== this.#generation) return;

    const store: StateStore = {
      load: async () => {
        if (generation !== this.#generation) throw new Error("sync configuration changed");
        return this.#state;
      },
      save: async (state) => {
        if (generation !== this.#generation) throw new Error("sync configuration changed");
        this.#state = state;
        await this.#persist();
        if (generation !== this.#generation) throw new Error("sync configuration changed");
      },
    };

    this.#engine = new SyncEngine({
      vault: new ObsidianVault(this.app),
      api: new SyncApi({
        baseUrl: serverUrl,
        token: this.settings.accessToken,
        http: obsidianHttp,
        lanes: this.settings.lanes,
      }),
      store,
      deviceName: this.settings.deviceName,
      excludes: parseGlobs(this.settings.excludes),
      onlyPaths: parseGlobs(this.settings.onlyPaths),
      mode: this.settings.syncMode,
      syncConfigDir: this.settings.syncConfigDir,
      maxBlobBytes: Math.round(this.settings.maxBlobMB * 1024 * 1024),
      crypto,
      protectPercent: this.settings.protectPercent,
      conflictMode: this.settings.conflictMode,
      lanes: this.settings.lanes,
      decideMassChange: (s) =>
        generation === this.#generation
          ? this.#decideMassChange(s)
          : Promise.resolve<MassChangeDecision>("cancel"),
      onProgress: ({ phase, done, total }) => {
        if (generation !== this.#generation) return;
        this.#progress = `${phase === "pull" ? "pulling" : "uploading"} ${done}/${total}`;
        this.#renderStatus();
      },
    });

    this.#scheduler = new SyncScheduler({
      engine: this.#engine,
      debounceMs: Math.max(500, this.settings.debounceSeconds * 1000),
      retryDelaysMs: RETRY_DELAYS_MS.slice(0, this.settings.retryAttempts),
      onResult: (r) => {
        if (generation === this.#generation) void this.#report(r);
      },
      onError: (e) => {
        if (generation === this.#generation) void this.#reportError(e);
      },
    });
    // The engine is built either way: answering the first-sync gate needs a manual sync, and
    // that runs through this scheduler. The status has to say so, or a device that is not
    // syncing at all looks identical to one that is up to date.
    this.#phase = needsFirstSyncConsent({
      acknowledged: this.settings.firstSyncAcknowledged,
      hasSyncedSnapshot: this.hasSyncedSnapshot,
    })
      ? "first-sync"
      : "idle";
    this.#renderStatus();
  }

  /**
   * Asked by the engine before a pull that would destroy an unusual share of the vault.
   * Only a sync the user is watching may raise a modal; an unattended pass returns "cancel"
   * so the decision waits for someone who can make it.
   */
  async #decideMassChange(summary: MassChangeSummary): Promise<MassChangeDecision> {
    if (this.#interactive === 0) return "cancel";
    return await new Promise<MassChangeDecision>((resolve) => {
      new MassChangeModal(this.app, summary, resolve).open();
    });
  }

  /**
   * The one-time "you are about to reconcile two real vaults" gate. Returns false when the
   * pass must not proceed: either the user declined, or nobody is watching to be asked.
   *
   * Persisted with `#persist`, never `saveSettings` — the flag is device-local, and
   * saveSettings retires the scheduler, which would deadlock the pass that called this.
   */
  async #confirmFirstSync(): Promise<boolean> {
    if (
      !needsFirstSyncConsent({
        acknowledged: this.settings.firstSyncAcknowledged,
        hasSyncedSnapshot: this.hasSyncedSnapshot,
      })
    ) {
      if (!this.settings.firstSyncAcknowledged) {
        // Already reconciled once, before this gate existed. Record it and never ask.
        this.settings.firstSyncAcknowledged = true;
        await this.#persist();
      }
      return true;
    }
    if (this.#interactive === 0 || this.#firstSyncModalOpen) {
      new Notice(
        "R2DO Sync has not started yet: the first sync needs a confirmation. Open settings " +
          "or sync manually to answer it.",
        10_000
      );
      return false;
    }
    this.#firstSyncModalOpen = true;
    const accepted = await new Promise<boolean>((resolve) => {
      new ConfirmModal(this.app, {
        title: "Back up this vault before the first sync",
        body: firstSyncConsentBody(this.settings.encryptionMode),
        confirmText: "I have a backup — sync",
        cancelText: "Not yet",
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false),
      }).open();
    });
    this.#firstSyncModalOpen = false;
    if (!accepted) {
      new Notice("R2DO Sync did not sync. It will ask again the next time you sync.", 8000);
      return false;
    }
    this.settings.firstSyncAcknowledged = true;
    await this.#persist();
    return true;
  }

  async syncNow(): Promise<void> {
    if (!this.#scheduler) {
      new Notice("R2DO Sync: set the server URL and access token in settings first");
      return;
    }
    this.#interactive++;
    try {
      if (!(await this.#confirmFirstSync())) return;
      this.#phase = "syncing";
      this.#renderStatus();
      try {
        await this.#syncSharedSettings();
      } catch (e) {
        // The file sync still runs — stale policy knobs beat not syncing notes at all.
        new Notice(`R2DO Sync: shared settings check failed: ${message(e)}`, 10_000);
      }
      if (!this.#scheduler) return;
      await this.#scheduler.syncNow();
    } catch {
      // reported through onError
    } finally {
      this.#interactive--;
    }
  }

  /** Shows what a sync would do, without doing any of it. */
  async previewSync(): Promise<void> {
    if (!this.#engine) {
      new Notice("R2DO Sync: set the server URL and access token in settings first");
      return;
    }
    const notice = new Notice("R2DO Sync: working out what a sync would do…", 0);
    try {
      const preview = await this.#engine.preview();
      new PreviewModal(this.app, preview).open();
    } catch (e) {
      new Notice(`R2DO Sync preview failed: ${message(e)}`, 10_000);
    } finally {
      notice.hide();
    }
  }

  async openHistory(): Promise<void> {
    if (!this.#engine) {
      new Notice("R2DO Sync: set the server URL and access token in settings first");
      return;
    }
    new HistoryModal(this.app, this, this.#engine).open();
  }

  /**
   * Make the current remote snapshot win on this device. Both force actions report what they
   * would do *before* asking, because neither reconciles: each one deliberately discards a
   * side that ordinary sync would have preserved.
   */
  async forcePull(): Promise<void> {
    const engine = this.#engine;
    if (engine === null) {
      new Notice("R2DO Sync: set the server URL and access token in settings first");
      return;
    }
    const summary = await this.#summarise(() => engine.forcePullSummary(), "pull the remote over this device");
    if (summary === null) return;

    new ConfirmModal(this.app, {
      title: "Pull the remote over this device?",
      body:
        `${summary.write} file(s) from snapshot ${summary.head} will be written over this ` +
        `vault, and ${describePaths(summary.remove, "local file")} will be removed. ` +
        `${
          summary.park.length === 0
            ? "Nothing here has changes this vault never published."
            : `${describePaths(summary.park, "file")} changed here but never published — ` +
              "each is kept as a .conflict-… copy beside the remote version."
        } The snapshot this replaces stays in history.`,
      phrase: "PULL REMOTE",
      onConfirm: async () => {
        const notice = new Notice("R2DO Sync: pulling the remote over this vault…", 0);
        this.#interactive++;
        try {
          const result = await engine.forcePull();
          notice.hide();
          new Notice(
            `R2DO Sync: wrote ${result.written} file(s), removed ${result.removed}` +
              `${result.parked.length > 0 ? `, kept ${result.parked.length} local copy(s)` : ""}. ` +
              "Publishing the result…",
            8000
          );
          await this.syncNow();
        } catch (e) {
          notice.hide();
          new Notice(`R2DO Sync could not pull the remote over this device: ${message(e)}`, 0);
        } finally {
          this.#interactive--;
        }
      },
    }).open();
  }

  /** Publish this device's files as the next snapshot without merging what others added. */
  async forcePush(): Promise<void> {
    const engine = this.#engine;
    const scheduler = this.#scheduler;
    if (engine === null || scheduler === null) {
      new Notice("R2DO Sync: set the server URL and access token in settings first");
      return;
    }
    // Publishing is publishing, however it is spelled. `syncNow` owns this gate and
    // `forcePull` inherits it by calling `syncNow`, but this path talks to the scheduler
    // directly — so without asking here a device that has never consented can overwrite the
    // remote with its whole vault. Asked before the preview, so the two dialogs do not stack.
    this.#interactive++;
    let consented: boolean;
    try {
      consented = await this.#confirmFirstSync();
    } finally {
      this.#interactive--;
    }
    if (!consented) return;

    const summary = await this.#summarise(() => engine.forcePushSummary(), "push this device over the remote");
    if (summary === null) return;

    new ConfirmModal(this.app, {
      title: "Push this device over the remote?",
      body:
        `${summary.files} file(s) from this device become the new snapshot, on top of ` +
        `${summary.head ?? "an empty vault"}. ${describePaths(summary.drop, "remote file")} ` +
        `will be left out of it${
          summary.drop.length > 0
            ? " — still restorable from Snapshot history, but gone from every device that pulls"
            : ""
        }. ${summary.carried} path(s) this device does not sync are carried unchanged. Local ` +
        "files are not touched.",
      phrase: "PUSH LOCAL",
      onConfirm: async () => {
        this.#phase = "syncing";
        this.#renderStatus();
        this.#interactive++;
        try {
          await scheduler.syncNow({ keepLocal: true });
        } catch {
          // reported through onError
        } finally {
          this.#interactive--;
        }
      },
    }).open();
  }

  /** Runs a force-action preview behind a notice, turning a refusal into a plain message. */
  async #summarise<T>(run: () => Promise<T>, action: string): Promise<T | null> {
    const notice = new Notice(`R2DO Sync: working out what this would change…`, 0);
    try {
      return await run();
    } catch (e) {
      new Notice(`R2DO Sync cannot ${action}: ${message(e)}`, 10_000);
      return null;
    } finally {
      notice.hide();
    }
  }

  async exportLog(): Promise<void> {
    const body = formatLogNote(this.#log, Date.now());
    const name = `r2do-sync-report-${stamp(Date.now())}.md`;
    try {
      const folder = await this.#ensureLogFolder();
      const path = folder === "" ? name : `${folder}/${name}`;
      await this.app.vault.create(path, body);
      new Notice(`R2DO Sync: wrote ${path}`);
    } catch (e) {
      new Notice(`R2DO Sync could not write the report: ${message(e)}`, 10_000);
    }
  }

  /**
   * The configured report folder, created if it does not exist yet. Returns "" for the
   * vault root. A path that exists but is a *file* is an error, not something to write
   * around — silently dumping the report elsewhere is how a user ends up believing they
   * have no logs.
   */
  async #ensureLogFolder(): Promise<string> {
    const folder = this.settings.logNoteFolder.trim().replace(/^\/+|\/+$/g, "");
    if (folder === "") return "";
    const existing = this.app.vault.getAbstractFileByPath(folder);
    if (existing instanceof TFolder) return folder;
    if (existing !== null) {
      throw new Error(`"${folder}" is a file, not a folder — change the report folder setting`);
    }
    await this.app.vault.createFolder(folder);
    return folder;
  }

  /** Applies a scanned setup link. The device identity changes, so cached sync state goes. */
  async applySetup(payload: SetupPayload): Promise<void> {
    this.settings.serverUrl = normalizeServerUrl(payload.url);
    this.settings.accessToken = payload.token;
    this.settings.deviceName = payload.name;
    this.settings.encryptionMode = payload.mode;
    this.settings.masterKey = payload.mode === "encrypted" ? payload.key : "";
    this.settings.masterKeyBackedUp = true;
    this.settings.vaultSalt = payload.mode === "encrypted" ? payload.vaultSalt : "";
    // A device pointed at a vault it has never synced owes the first-pass acknowledgement
    // again: the reconciliation ahead of it is with a different set of remote files.
    this.settings.firstSyncAcknowledged = false;
    this.#pendingEncryptionTransition = null;
    this.#state = null;
    this.#sharedSettings = null;
    this.#keyMismatch = null;
    await this.saveSettings();
    // A just-configured device must ADOPT the vault's shared settings, not publish its own
    // defaults over them — cancel the push saveSettings scheduled and let the first sync's
    // pull-then-push ordering decide.
    if (this.#settingsPushTimer !== null) {
      window.clearTimeout(this.#settingsPushTimer);
      this.#settingsPushTimer = null;
    }

    try {
      const head = await new SyncApi({
        baseUrl: this.settings.serverUrl,
        token: this.settings.accessToken,
        http: obsidianHttp,
      }).getHead();
      new Notice(
        `R2DO Sync configured as "${payload.name}"${payload.mode === "encrypted" ? " (encrypted)" : " (plaintext)"}. Remote head: ${head ?? "(empty vault)"}`,
        10_000
      );
      // A device that was just set up should not sit idle until someone finds the ribbon.
      // Interactive, so the mass-change guard may ask instead of silently parking.
      void this.syncNow();
    } catch (e) {
      new Notice(`R2DO Sync configured, but the connection test failed: ${message(e)}`, 0);
    }
  }

  /** Opens the mandatory one-time backup gate for the current generated key. */
  #promptBackupKey(): void {
    if (this.#backupModalOpen || this.settings.masterKey.trim() === "") return;
    this.#backupModalOpen = true;
    new BackupKeyModal(this.app, {
      key: this.settings.masterKey,
      onSaved: async () => {
        await this.#applyEncryptionTarget({
          mode: "encrypted",
          key: this.settings.masterKey,
          backedUp: true,
          vaultSalt: this.settings.vaultSalt,
        });
      },
      onClose: () => {
        this.#backupModalOpen = false;
      },
    }).open();
  }

  /**
   * Stages an explicit encryption/key target. Encrypted targets first pass through the
   * backup gate; established vaults then transform the remote snapshot with one CAS.
   */
  requestEncryptionTarget(mode: EncryptionMode, key: string, vaultSalt: string): void {
    const trimmedKey = key.trim();
    if (mode === "encrypted") {
      try {
        parseMasterKey(trimmedKey);
        parseVaultSalt(vaultSalt);
      } catch (error) {
        new Notice(`Cannot change encryption: ${message(error)}`, 10_000);
        return;
      }
      if (this.#backupModalOpen) return;
      this.#backupModalOpen = true;
      new BackupKeyModal(this.app, {
        key: trimmedKey,
        onSaved: () => this.#applyEncryptionTarget({
          mode,
          key: trimmedKey,
          backedUp: true,
          vaultSalt,
        }),
        onClose: () => {
          this.#backupModalOpen = false;
        },
      }).open();
      return;
    }
    void this.#applyEncryptionTarget({ mode, key: "", backedUp: true, vaultSalt: "" }).catch(
      (error) => new Notice(`Cannot change encryption: ${message(error)}`, 0)
    );
  }

  async #applyEncryptionTarget(target: PendingEncryptionTransition): Promise<void> {
    if (target.mode === "encrypted") parseVaultSalt(target.vaultSalt);
    const targetCrypto = target.mode === "encrypted" ? await VaultCrypto.fromText(target.key) : null;
    const currentKeyId = this.encryptionEnabled
      ? (await VaultCrypto.fromText(this.settings.masterKey)).keyId
      : null;
    const targetKeyId = targetCrypto?.keyId ?? null;

    // With no local base, inspect the remote rather than assuming it is empty. A fresh
    // target can adopt an absent head or an exact existing mode/key; transforming a
    // different remote identity requires first syncing it in its current mode.
    if (this.#state?.lastSyncedHead == null) {
      if (!this.settings.serverUrl || !this.settings.accessToken) {
        throw new Error("set the server URL and access token before changing encryption");
      }
      const api = new SyncApi({
        baseUrl: this.settings.serverUrl,
        token: this.settings.accessToken,
        http: obsidianHttp,
      });
      const head = await api.getHead();
      if (head !== null) {
        const manifest = await api.getManifest(head);
        if (!remoteManifestMatchesTarget(manifest, targetKeyId)) {
          const remoteMode = manifest.v === 1 ? "plaintext" : `encrypted key ${manifest.keyId}`;
          throw new Error(
            `remote head is ${remoteMode}, not the requested target; configure that current ` +
            "mode/key and sync once to adopt it before running REKEY"
          );
        }
      }
      this.#activateEncryptionTarget(target);
      await this.saveSettings();
      return;
    }
    if (currentKeyId === targetKeyId) {
      this.#activateEncryptionTarget(target);
      await this.saveSettings();
      return;
    }
    const engine = this.#engine;
    const scheduler = this.#scheduler;
    if (engine === null || scheduler === null) {
      throw new Error("current encryption mode is not ready; fix its key before migrating");
    }

    this.#pendingEncryptionTransition = target;
    await this.#persist();
    await scheduler.stopAndWait();
    try {
      const migrated = await engine.migrateEncryption(targetCrypto);
      this.#activateEncryptionTarget(target);
      this.#pendingEncryptionTransition = null;
      // Force the settings document to be rewritten under the target mode/key.
      this.#sharedSettings = null;
      await this.saveSettings();
      new Notice(
        `R2DO Sync migrated ${migrated.files} file(s) to ${target.mode === "encrypted" ? "encrypted" : "plaintext"} storage.`,
        10_000
      );
    } catch (error) {
      this.#pendingEncryptionTransition = null;
      await this.#persist();
      await this.rebuild();
      new Notice(`Encryption migration failed: ${message(error)}`, 0);
      throw error;
    }
  }

  #activateEncryptionTarget(target: PendingEncryptionTransition): void {
    const next = activateEncryptionState(this.settings, {
      encryptionMode: target.mode,
      masterKey: target.key,
      masterKeyBackedUp: target.backedUp,
      vaultSalt: target.vaultSalt,
    });
    if (this.settings.vaultSalt !== next.vaultSalt) this.#sharedSettings = null;
    this.settings.encryptionMode = next.encryptionMode;
    this.settings.masterKey = next.masterKey;
    this.settings.masterKeyBackedUp = next.masterKeyBackedUp;
    this.settings.vaultSalt = next.vaultSalt;
  }

  /** Resume a crash-interrupted transition before any automatic pass can run. */
  async #resumeEncryptionTransition(): Promise<void> {
    const pending = this.#pendingEncryptionTransition;
    if (pending === null || !this.settings.serverUrl || !this.settings.accessToken) return;
    try {
      if (pending.mode === "encrypted") parseVaultSalt(pending.vaultSalt);
      const targetCrypto = pending.mode === "encrypted" ? await VaultCrypto.fromText(pending.key) : null;
      const api = new SyncApi({
        baseUrl: this.settings.serverUrl,
        token: this.settings.accessToken,
        http: obsidianHttp,
      });
      const head = await api.getHead();
      if (head !== null) {
        const manifest = await api.getManifest(head);
        const remoteMatches = remoteManifestMatchesTarget(manifest, targetCrypto?.keyId ?? null);
        if (remoteMatches) {
          this.#activateEncryptionTarget(pending);
          this.#pendingEncryptionTransition = null;
          // If the process died after CAS but before the engine persisted target state,
          // force a target-mode pull rather than trusting a source-mode cache.
          if ((this.#state?.keyId ?? null) !== (targetCrypto?.keyId ?? null)) this.#state = null;
          this.#sharedSettings = null;
          await this.saveSettings();
          return;
        }
      }
      await this.#applyEncryptionTarget(pending);
    } catch (error) {
      await this.rebuild();
      new Notice(`R2DO Sync could not resume encryption migration: ${message(error)}`, 0);
    }
  }

  async #report(result: SyncResult): Promise<void> {
    const at = Date.now();
    this.#log = appendLog(this.#log, entryFromResult(result, at), this.settings.logEntries);
    this.#progress = null;
    if (result.status === "committed" || result.status === "pulled" || result.status === "unchanged") {
      this.#lastSuccessAt = at;
    } else {
      this.#lastFailureAt = at;
    }

    // The vault halt is the other face of a wrong key, and the usual one on a vault with no
    // shared-settings document yet. Same cure, so it earns the same inline offer.
    if (result.status === "halted" && SyncEngine.isWrongKeyHalt(result.reason)) {
      this.#keyMismatch = result.reason;
    }

    this.#notify(result);
    this.#reportConflicts(result);
    this.#phase =
      result.status === "halted"
        ? "halted"
        : result.status === "needs-decision"
          ? "decision"
          : "idle";
    this.#renderStatus();
    await this.#persist();
  }

  /**
   * Conflicts get their own message on EVERY pass, unattended ones included — unlike an
   * ordinary "up to date", a conflict is exactly the event a user must not miss. A watched
   * pass opens the detail modal directly; a background one gets a notice pointing at the
   * review command instead, because there may be no one at the screen to dismiss a modal.
   */
  #reportConflicts(result: SyncResult): void {
    const details = result.conflictDetails;
    if (details.length === 0) return;
    this.#lastConflicts = details;
    if (this.#interactive > 0) {
      this.openConflictReview(details);
      return;
    }
    const names = details.map((c) => c.path);
    const shown = names.slice(0, 3).join(", ");
    const more = names.length > 3 ? ` +${names.length - 3} more` : "";
    new Notice(
      `R2DO Sync: ${names.length} conflict${names.length === 1 ? "" : "s"} — ${shown}${more}. ` +
        `Run "Review and resolve conflicts" to see the differences and pick a side.`,
      15_000
    );
  }

  /** The conflicts from the most recent pass that reported any, newest batch only. */
  get lastConflicts(): ConflictInfo[] {
    return this.#lastConflicts;
  }

  /** How the hotkey manager keys "Sync now": qualified with this plugin's id. */
  get syncCommandId(): string {
    return `${this.manifest.id}:${SYNC_COMMAND}`;
  }

  /** What to type into Settings → Hotkeys to find this plugin's commands. */
  get hotkeySearchQuery(): string {
    return this.manifest.name;
  }

  /** Opens the conflict view, wired so a choice made in it actually resolves the file. */
  openConflictReview(conflicts: ConflictInfo[]): void {
    new ConflictReportModal(this.app, conflicts, {
      readText: (path) => this.#readTextIfPresent(path),
      resolve: (info, choice) => this.resolveConflict(info, choice),
    }).open();
  }

  /** A file's text, or null when it is absent or not decodable text. */
  async #readTextIfPresent(path: string): Promise<string | null> {
    const vault = new ObsidianVault(this.app);
    try {
      return decodeText(await vault.read(path));
    } catch {
      return null;
    }
  }

  /**
   * Carries out the user's choice for one conflict.
   *
   * Both files are re-read here rather than trusting what the modal was drawn from: a pass may
   * have parked this copy minutes ago and the user may have edited or deleted either side since.
   * Overwriting an edit made in that window is precisely the loss this feature exists to
   * prevent, so a missing or unreadable side stops with a message instead.
   *
   * Nothing is committed. The next ordinary pass publishes the outcome, which keeps this off the
   * commit path entirely.
   */
  async resolveConflict(info: ConflictInfo, choice: ConflictChoice): Promise<void> {
    if (this.#phase === "syncing") {
      throw new Error("a sync is running — wait for it to finish, then resolve this conflict");
    }
    const vault = new ObsidianVault(this.app);
    const present = new Set((await vault.list()).map((f) => f.path));
    const ops = planResolutionOnDisk(info, choice, {
      present,
      mine: present.has(info.path) ? await this.#readTextIfPresent(info.path) : null,
      theirs:
        info.copy !== null && present.has(info.copy)
          ? await this.#readTextIfPresent(info.copy)
          : null,
    });
    const encoder = new TextEncoder();
    for (const write of ops.writes) await vault.write(write.path, encoder.encode(write.text));
    for (const path of ops.removes) await vault.remove(path);

    // Resolved conflicts leave the review list, so what it shows is what is still outstanding.
    if (choice !== "keep-both") {
      this.#lastConflicts = this.#lastConflicts.filter((c) => c.copy !== info.copy);
      await this.#persist();
    }
  }

  async #reportError(e: Error): Promise<void> {
    this.#log = appendLog(this.#log, entryFromError(e, Date.now()), this.settings.logEntries);
    this.#lastFailureAt = Date.now();
    this.#progress = null;
    this.#phase = "idle";
    this.#renderStatus();
    new Notice(`R2DO Sync error: ${e.message}`, 10_000);
    await this.#persist();
  }

  #notify(result: SyncResult): void {
    const changed = passChangedSomething(result);
    if (
      announcePass({
        notifyOnSync: this.settings.notifyOnSync,
        onlyChanged: this.settings.notifyOnlyChanged,
        interactive: this.#interactive > 0,
        result,
      })
    ) {
      const verbose = this.settings.verboseSyncNotice;
      // A named list takes longer to read than "up to date", and a pass that moved nothing
      // should not linger on screen.
      const duration = !changed ? 4_000 : verbose ? 12_000 : 8_000;
      new Notice(`R2DO Sync\n${describePass(result, { verbose })}`, duration);
    } else if (result.pulled > 0) {
      // The floor no setting removes: files changed under the user without them asking.
      new Notice(`R2DO Sync changed ${result.pulled} local file(s)`);
    }
    if (result.skipped.length > 0) {
      const detail = result.skipped
        .slice(0, 5)
        .map((s) => `${s.path} (${s.reason})`)
        .join("\n");
      new Notice(`R2DO Sync skipped ${result.skipped.length} file(s):\n${detail}`, 10_000);
    }
    if (result.conflicts.length > 0) {
      // Never a silent resolution: both versions are on disk and the user has to choose.
      new Notice(
        `R2DO Sync could not merge ${result.conflicts.length} file(s). The other device's ` +
          `version is saved beside yours:\n${result.conflicts.slice(0, 5).join("\n")}`,
        0
      );
    }
    if (result.status === "halted") {
      new Notice(`R2DO Sync halted: ${result.reason}`, 0);
      return;
    }
    if (result.status === "needs-decision") {
      const { deletes, overwrites, percent } = result.summary;
      new Notice(
        `R2DO Sync paused: the remote would delete ${deletes.length} and overwrite ` +
          `${overwrites.length} file(s) here — ${percent}% of this vault. Run "Sync now" to ` +
          `review and choose what happens.`,
        0
      );
    }
  }

  #renderStatus(): void {
    const lock = this.encryptionEnabled ? "🔒 " : "";
    if (this.#statusBar) {
      this.#statusBar.setText(`Sync: ${lock}${this.#statusText()}`);
      this.#statusBar.setAttr("aria-label", this.#statusTooltip());
    }
    // On mobile this tooltip is the whole status display, so it carries the same text the
    // desktop status bar shows rather than a fixed label.
    if (this.#ribbon) {
      setIcon(this.#ribbon, this.#phase === "syncing" ? "loader-circle" : "refresh-cw");
      this.#ribbon.setAttr("aria-label", `R2DO Sync: ${lock}${this.#statusText()}`);
    }
  }

  #statusText(): string {
    if (this.#progress) return this.#progress;
    switch (this.#phase) {
      case "unconfigured":
        return "not configured";
      case "syncing":
        return "syncing…";
      case "halted":
        return "HALTED";
      case "decision":
        return "action needed";
      case "backup-required":
        return "BACK UP KEY";
      case "first-sync":
        return "CONFIRM FIRST SYNC";
      case "idle":
        return this.#lastPassText();
    }
  }

  /**
   * A failure has to stay visible: without this the bar would read "synced 2h ago" while
   * every pass since has been failing, which is exactly the silence this is meant to break.
   */
  #lastPassText(): string {
    const now = Date.now();
    const failed = this.#lastFailureAt;
    const ok = this.#lastSuccessAt;
    if (failed !== undefined && (ok === undefined || failed > ok)) {
      return `failed ${relativeTime(failed, now)}`;
    }
    if (ok !== undefined) return `synced ${relativeTime(ok, now)}`;
    return "never synced";
  }

  #statusTooltip(): string {
    const last = this.#log[0];
    if (!last) return "R2DO Sync — click to sync now";
    const when = new Date(last.at).toLocaleString();
    return `R2DO Sync — last pass ${last.status} at ${when}\n${last.detail || "no changes"}\nClick to sync now`;
  }

  async #persist(): Promise<void> {
    const data = {
      settings: { ...this.settings },
      state: this.#state,
      stateServerUrl: this.#stateServerUrl,
      log: this.#log,
      lastSuccessAt: this.#lastSuccessAt,
      lastFailureAt: this.#lastFailureAt,
      sharedSettings: this.#sharedSettings,
      lastConflicts: this.#lastConflicts,
      pendingEncryptionTransition: this.#pendingEncryptionTransition,
    } satisfies PersistedData;
    const save = this.#persistChain.then(() => this.saveData(data));
    this.#persistChain = save.catch(() => {});
    await save;
  }

  async saveSettings(): Promise<void> {
    // Invalidate the old store/report callbacks before the first await. Settings controls
    // mutate the object just before calling this method.
    const generation = this.#retireScheduler();
    const nextStateServerUrl = endpointIdentity(this.settings.serverUrl);
    if (nextStateServerUrl !== this.#stateServerUrl) {
      this.#state = null;
      // A different server's settings document has nothing to do with this one.
      this.#sharedSettings = null;
      // Nor does the consent. It was given for the files of one vault, and the pass ahead
      // reconciles against a different set — which is precisely why `applySetup` already
      // re-arms it. Typing a new URL into the field has to mean the same thing.
      this.settings.firstSyncAcknowledged = false;
    }
    this.#stateServerUrl = nextStateServerUrl;
    await this.#persist();
    // Before the rebuild's awaits: a new interval is live as soon as the value is stored,
    // whether or not the engine behind it could be rebuilt.
    this.#restartAutoSyncTimer();
    await this.#finishRebuild(generation);
    this.#schedulePushSharedSettings();
  }
}

/** Compact local timestamp for generated filenames: yymmdd-HHmm. */
function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function endpointIdentity(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Adds a show/hide toggle beside a masked field. Secrets stay hidden by default so they do
 * not end up in a screen share, but they have to be readable to be copied to a new device.
 */
/**
 * "3 local files (a.md, b.md, +1 more)". The count is what the decision turns on; a few
 * names are the sanity check that it is the right set — a full list would be a wall of text
 * in a modal nobody then reads.
 */
function describePaths(paths: string[], noun: string): string {
  const head = `${paths.length} ${noun}${paths.length === 1 ? "" : "s"}`;
  if (paths.length === 0) return head;
  const shown = paths.slice(0, 5);
  const rest = paths.length - shown.length;
  return `${head} (${shown.join(", ")}${rest > 0 ? `, +${rest} more` : ""})`;
}

function addReveal(setting: Setting, input: HTMLInputElement): void {
  setting.addExtraButton((b) =>
    b
      .setIcon("eye")
      .setTooltip("Show or hide")
      .onClick(() => {
        const hidden = input.type === "password";
        input.type = hidden ? "text" : "password";
        b.setIcon(hidden ? "eye-off" : "eye");
      })
  );
}

/**
 * A secret shown where it can be read and copied: selectable, and still there after the
 * clipboard is refused. A `Notice` cannot do this job — it floats over the page until it is
 * dismissed, cannot be selected on a phone, and is what ends up in a screenshot.
 */
function secretField(parent: HTMLElement, value: string, label: string): HTMLTextAreaElement {
  const field = parent.createEl("textarea");
  field.value = value;
  field.readOnly = true;
  field.rows = 3;
  field.setAttr("aria-label", label);
  return field;
}

/** Copies a secret, falling back to selecting it when the platform refuses the clipboard. */
async function copySecret(value: string, field: HTMLTextAreaElement, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    new Notice(`${label} copied`);
  } catch (error) {
    new Notice(`Could not copy the ${label.toLowerCase()}: ${message(error)}. Select it manually.`, 10_000);
    field.focus();
    field.select();
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Renders a QR code as inline SVG, built through the DOM rather than innerHTML. */
function renderQr(parent: HTMLElement, text: string, pixel = 5): void {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const quiet = 4;
  const side = (count + quiet * 2) * pixel;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(side));
  svg.setAttribute("height", String(side));
  svg.setAttribute("viewBox", `0 0 ${side} ${side}`);

  const bg = document.createElementNS(SVG_NS, "rect");
  bg.setAttribute("width", String(side));
  bg.setAttribute("height", String(side));
  bg.setAttribute("fill", "#ffffff");
  svg.appendChild(bg);

  // One path beats thousands of <rect> nodes at this module count.
  let d = "";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (!qr.isDark(row, col)) continue;
      const x = (col + quiet) * pixel;
      const y = (row + quiet) * pixel;
      d += `M${x} ${y}h${pixel}v${pixel}h-${pixel}z`;
    }
  }
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "#000000");
  svg.appendChild(path);

  parent.appendChild(svg);
}

/**
 * Raised when a pull would delete or overwrite an unusual share of the vault. Both
 * directions are offered because either side can be the good one: the remote may hold a
 * legitimate cleanup from another device, or it may be the damaged copy. Neither choice
 * destroys anything permanently — the snapshot being replaced stays in the chain.
 */
class MassChangeModal extends Modal {
  #answered = false;

  constructor(
    app: App,
    private readonly summary: MassChangeSummary,
    private readonly resolve: (d: MassChangeDecision) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, summary } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Large change — which side is right?" });
    contentEl.createEl("p", {
      text:
        `Another device's snapshot would delete ${summary.deletes.length} and overwrite ` +
        `${summary.overwrites.length} of the ${summary.localFileCount} files this device ` +
        `syncs — ${summary.percent}% of the vault, over your ${summary.threshold}% limit.`,
    });

    this.#list("Would be deleted here", summary.deletes);
    this.#list("Would be overwritten here", summary.overwrites);

    contentEl.createEl("p", {
      text:
        "Nothing is lost either way: the snapshot you do not pick stays in the history and " +
        "can be restored from Browse snapshot history.",
    });

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText("Apply remote")
          .setWarning()
          .onClick(() => this.#answer("apply-remote"))
      )
      .addButton((b) =>
        b
          .setButtonText("Keep local")
          .setCta()
          .onClick(() => this.#answer("keep-local"))
      )
      .addButton((b) => b.setButtonText("Decide later").onClick(() => this.#answer("cancel")));
  }

  #list(title: string, paths: string[]): void {
    if (paths.length === 0) return;
    this.contentEl.createEl("h4", { text: `${title} (${paths.length})` });
    const ul = this.contentEl.createEl("ul");
    for (const p of paths.slice(0, 15)) ul.createEl("li", { text: p });
    if (paths.length > 15) {
      ul.createEl("li", { text: `…and ${paths.length - 15} more` });
    }
  }

  #answer(decision: MassChangeDecision): void {
    this.#answered = true;
    this.resolve(decision);
    this.close();
  }

  onClose(): void {
    // Dismissing the modal is not consent. Anything but an explicit choice defers.
    if (!this.#answered) this.resolve("cancel");
    this.contentEl.empty();
  }
}

/** Read-only report of what a sync would do right now. */
class PreviewModal extends Modal {
  constructor(
    app: App,
    private readonly preview: SyncPreview
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, preview } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Sync preview" });
    contentEl.createEl("p", {
      text: `Remote head: ${preview.head ?? "(empty vault)"}. Nothing has been changed.`,
    });

    if (preview.halted) {
      contentEl.createEl("p", { text: `Sync would halt: ${preview.halted}` });
      return;
    }
    if (preview.guard) {
      contentEl.createEl("p", {
        text:
          `This pass would pause for a decision: ${preview.guard.percent}% of the vault ` +
          `would be deleted or overwritten locally.`,
      });
    }
    if (preview.pull.length === 0 && preview.push.length === 0) {
      contentEl.createEl("p", { text: "Both sides are already in step — nothing to do." });
    }

    this.#section("Would change on this device", preview.pull);
    this.#section("Would be published to the remote", preview.push);

    if (preview.skipped.length > 0) {
      contentEl.createEl("h4", { text: `Skipped (${preview.skipped.length})` });
      const ul = contentEl.createEl("ul");
      for (const s of preview.skipped.slice(0, 20)) {
        ul.createEl("li", { text: `${s.path} — ${s.reason}` });
      }
    }
  }

  #section(title: string, actions: { path: string; action: string }[]): void {
    if (actions.length === 0) return;
    this.contentEl.createEl("h4", { text: `${title} (${actions.length})` });
    const ul = this.contentEl.createEl("ul");
    for (const a of actions.slice(0, 50)) {
      ul.createEl("li", { text: `${a.action}: ${a.path}` });
    }
    if (actions.length > 50) ul.createEl("li", { text: `…and ${actions.length - 50} more` });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Walks the snapshot chain so a past state can be inspected and restored. */
class HistoryModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: LogSyncPlugin,
    private readonly engine: SyncEngine
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Snapshot history" });
    const status = contentEl.createEl("p", { text: "Loading…" });

    let history: SnapshotInfo[];
    try {
      history = await this.engine.listHistory(this.plugin.settings.historyLimit);
    } catch (e) {
      status.setText(`Could not read history: ${message(e)}`);
      return;
    }

    if (history.length === 0) {
      status.setText("The remote has no snapshots yet.");
      return;
    }
    status.setText(
      `Newest first. Older snapshots are removed by the server's retention policy, so this ` +
        `list can be shorter than the vault's full history.`
    );

    for (const snap of history) {
      const when = new Date(snap.createdAt).toLocaleString();
      const setting = new Setting(contentEl)
        .setName(`${when} — ${snap.device}`)
        .setDesc(
          snap.readable
            ? `${snap.fileCount} file(s) · ${snap.id}`
            : `unreadable with this device's key · ${snap.id}`
        );
      if (!snap.readable) continue;
      setting.addButton((b) =>
        b.setButtonText("Browse").onClick(() => {
          this.close();
          new SnapshotModal(this.app, this.plugin, this.engine, snap).open();
        })
      );
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** One snapshot's contents, with per-file and whole-vault restore. */
class SnapshotModal extends Modal {
  #paths: string[] = [];
  #filter = "";
  #listEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly plugin: LogSyncPlugin,
    private readonly engine: SyncEngine,
    private readonly snap: SnapshotInfo
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Snapshot contents" });
    contentEl.createEl("p", {
      text: `${new Date(this.snap.createdAt).toLocaleString()} — ${this.snap.device} — ${this.snap.id}`,
    });

    try {
      this.#paths = Object.keys(await this.engine.snapshotFiles(this.snap.id)).sort();
    } catch (e) {
      contentEl.createEl("p", { text: `Could not read this snapshot: ${message(e)}` });
      return;
    }

    new Setting(contentEl)
      .setName("Restore the whole vault to this snapshot")
      .setDesc(
        "Writes every file above and removes synced files this snapshot does not have. " +
          "Your current state stays in the history and can be restored the same way."
      )
      .addButton((b) =>
        b
          .setButtonText("Restore all")
          .setWarning()
          .onClick(() => this.#confirmRestoreAll())
      );

    new Setting(contentEl).setName("Filter").addText((t) =>
      t.setPlaceholder("path contains…").onChange((v) => {
        this.#filter = v.trim().toLowerCase();
        this.#renderList();
      })
    );

    this.#listEl = contentEl.createDiv();
    this.#renderList();
  }

  #renderList(): void {
    const list = this.#listEl;
    if (!list) return;
    list.empty();

    const matches = this.#paths.filter((p) => p.toLowerCase().includes(this.#filter));
    list.createEl("p", { text: `${matches.length} of ${this.#paths.length} file(s)` });

    for (const path of matches.slice(0, 100)) {
      new Setting(list).setName(path).addButton((b) =>
        b.setButtonText("Restore").onClick(async () => {
          try {
            await this.engine.restoreFile(this.snap.id, path);
            new Notice(`Restored ${path}`);
          } catch (e) {
            new Notice(`Could not restore ${path}: ${message(e)}`, 10_000);
          }
        })
      );
    }
    if (matches.length > 100) {
      list.createEl("p", { text: `…and ${matches.length - 100} more. Narrow the filter to see them.` });
    }
  }

  #confirmRestoreAll(): void {
    new ConfirmModal(this.app, {
      title: "Restore the whole vault?",
      body:
        `Every file this device syncs will be made to match snapshot ${this.snap.id}. Files ` +
        `added since then will be moved to the trash. Nothing is lost permanently — the ` +
        `current state remains in the snapshot history.`,
      phrase: "RESTORE",
      onConfirm: async () => {
        const notice = new Notice("Restoring…", 0);
        try {
          const { written, removed } = await this.engine.restoreAll(this.snap.id);
          new Notice(`Restored ${written} file(s), removed ${removed}. Syncing to publish it.`);
          this.close();
          await this.plugin.syncNow();
        } catch (e) {
          new Notice(`Restore failed: ${message(e)}`, 10_000);
        } finally {
          notice.hide();
        }
      },
    }).open();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Typed confirmation for the handful of actions that rewrite a lot of state at once. */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * What actually happened to each unmergeable pair, with the facts needed to judge it:
 * which side holds the real path now, when each side was last edited and how big it is,
 * and where the losing version went (a parked copy, or discarded by an overwrite mode).
 */
/**
 * The conflict view: what disagreed, and what to do about it.
 *
 * A pass has already parked the losing version, so every choice offered here is reversible right
 * up to the moment it is taken and nothing is lost by looking first. The newer side is marked and
 * its button is the default, because "which of these did I write last" is the question a user
 * actually has.
 */
export class ConflictReportModal extends Modal {
  constructor(
    app: App,
    private readonly conflicts: ConflictInfo[],
    private readonly actions: {
      readText: (path: string) => Promise<string | null>;
      resolve: (info: ConflictInfo, choice: ConflictChoice) => Promise<void>;
    } | null = null
  ) {
    super(app);
  }

  onOpen(): void {
    this.#render();
  }

  #render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const outstanding = this.conflicts;
    contentEl.createEl("h2", {
      text: `${outstanding.length} conflict${outstanding.length === 1 ? "" : "s"}`,
    });
    if (outstanding.length === 0) {
      contentEl.createEl("p", { text: "All resolved." });
      new Setting(contentEl).addButton((b) =>
        b.setButtonText("Close").setCta().onClick(() => this.close())
      );
      return;
    }
    contentEl.createEl("p", {
      text:
        "Both sides changed these files in ways that could not be merged. Both versions are on " +
        "disk; pick one, or combine them into a single file to sort out by hand.",
    });

    const now = Date.now();
    for (const c of outstanding) {
      const box = contentEl.createDiv({ cls: "r2do-conflict" });
      box.createEl("h4", { text: c.path });
      const newer = latestSide(c);
      const side = (label: string, s: { mtime: number; size: number }, mine: boolean) =>
        `${label}${(mine ? "mine" : "theirs") === newer ? " — LATEST" : ""}: edited ` +
        `${new Date(s.mtime).toLocaleString()} (${relativeTime(s.mtime, now)}), ${fmtBytes(s.size)}`;
      const list = box.createEl("ul");
      list.createEl("li", { text: side("This device", c.ours, true) });
      list.createEl("li", { text: side("Other device", c.theirs, false) });

      if (!isResolvable(c)) {
        list.createEl("li", {
          text:
            "The losing version was overwritten by the conflict handling setting, so there is " +
            "nothing left to choose. The remote side stays in snapshot history; a local-only " +
            "edit does not.",
        });
        continue;
      }
      list.createEl("li", { text: `Other version saved as: ${c.copy}` });
      if (this.actions === null) continue;
      this.#renderDiff(box, c);
      this.#renderChoices(box, c, newer);
    }

    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Close").onClick(() => this.close())
    );
  }

  /** Loads and draws the diff after the row, so the modal opens immediately either way. */
  #renderDiff(box: HTMLElement, c: ConflictInfo): void {
    const holder = box.createDiv({ cls: "r2do-diff" });
    holder.createEl("p", { text: "Loading the difference..." });
    void (async () => {
      const mine = await this.actions!.readText(c.path);
      const theirs = await this.actions!.readText(c.copy!);
      holder.empty();
      if (mine === null || theirs === null) {
        holder.createEl("p", {
          text: "One side is not text, so there is no line-by-line difference to show.",
        });
        return;
      }
      const diff = conflictDiff(mine, theirs);
      if (diff === null) {
        holder.createEl("p", { text: "These versions are too large to compare line by line." });
        return;
      }
      const pre = holder.createEl("pre", { cls: "r2do-diff-body" });
      for (const row of diff.rows) {
        const mark = row.kind === "ours" ? "-" : row.kind === "theirs" ? "+" : " ";
        pre.createEl("div", {
          text: `${mark} ${row.text}`,
          cls: `r2do-diff-${row.kind}`,
        });
      }
      if (diff.truncated > 0) {
        holder.createEl("p", { text: `... ${diff.truncated} more differing lines not shown.` });
      }
    })();
  }

  #renderChoices(box: HTMLElement, c: ConflictInfo, newer: "mine" | "theirs"): void {
    const row = new Setting(box).setName("Keep");
    const button = (text: string, choice: ConflictChoice, cta: boolean) =>
      row.addButton((b) => {
        b.setButtonText(text).onClick(async () => {
          try {
            await this.actions!.resolve(c, choice);
            new Notice(`R2DO Sync: ${c.path} resolved`);
            this.conflicts.splice(this.conflicts.indexOf(c), 1);
            this.#render();
          } catch (e) {
            new Notice(`R2DO Sync could not resolve ${c.path}: ${message(e)}`, 10_000);
          }
        });
        if (cta) b.setCta();
      });

    button(newer === "mine" ? "This device" : "Other device", newer === "mine" ? "keep-mine" : "keep-theirs", true);
    button(newer === "mine" ? "Other device" : "This device", newer === "mine" ? "keep-theirs" : "keep-mine", false);
    button("Both files", "keep-both", false);
    button("Combine into one", "combine", false);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class ConfirmModal extends Modal {
  /** So `onCancel` fires exactly once, whether the user cancels or dismisses the window. */
  #settled = false;

  constructor(
    app: App,
    private readonly opts: {
      title: string;
      /** One paragraph, or several — a wall of text is a dialog nobody reads. */
      body: string | readonly string[];
      /** When set, the phrase must be typed. Absent: a plain second-confirm button. */
      phrase?: string;
      confirmText?: string;
      cancelText?: string;
      onConfirm: () => void | Promise<void>;
      onCancel?: () => void;
    }
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, opts } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: opts.title });
    for (const paragraph of typeof opts.body === "string" ? [opts.body] : opts.body) {
      contentEl.createEl("p", { text: paragraph });
    }

    const phrase = opts.phrase;
    let typed = "";
    let confirm: { setDisabled(v: boolean): unknown } | null = null;

    if (phrase !== undefined) {
      new Setting(contentEl)
        .setName(`Type ${phrase} to continue`)
        .addText((t) =>
          t.onChange((v) => {
            typed = v.trim();
            confirm?.setDisabled(typed !== phrase);
          })
        );
    }

    new Setting(contentEl)
      .addButton((b) => {
        confirm = b;
        b.setButtonText(opts.confirmText ?? "Confirm")
          .setWarning()
          .setDisabled(phrase !== undefined)
          .onClick(async () => {
            if (phrase !== undefined && typed !== phrase) return;
            this.#settled = true;
            this.close();
            await opts.onConfirm();
          });
      })
      .addButton((b) => b.setButtonText(opts.cancelText ?? "Cancel").onClick(() => this.close()));
  }

  onClose(): void {
    // Dismissing the window is a refusal, not silence: a caller awaiting an answer would
    // otherwise hang forever, and a control reset by onCancel would keep the wrong value.
    if (!this.#settled) {
      this.#settled = true;
      this.opts.onCancel?.();
    }
    this.contentEl.empty();
  }
}

/**
 * Shows a generated/derived key exactly when it must be backed up. Closing the modal is
 * allowed, but it grants nothing: the engine remains disabled until “I saved it” succeeds.
 */
class BackupKeyModal extends Modal {
  constructor(
    app: App,
    private readonly opts: {
      key: string;
      onSaved: () => Promise<void>;
      onClose: () => void;
    }
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Back up the vault master key" });
    contentEl.createEl("p", {
      text:
        "This key is the only way to recover encrypted snapshots. Save it in a password " +
        "manager now. Sync remains disabled until you confirm the backup.",
    });
    const key = secretField(contentEl, this.opts.key, "Vault master key");

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText("Copy key")
          .onClick(() => copySecret(this.opts.key, key, "Vault master key"))
      )
      .addButton((button) =>
        button
          .setButtonText("I saved it")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            try {
              await this.opts.onSaved();
              this.close();
            } catch (error) {
              button.setDisabled(false);
              new Notice(`Could not finish the encryption change: ${message(error)}`, 0);
            }
          })
      );
  }

  onClose(): void {
    // Merely dismissing the window is never equivalent to acknowledging a backup.
    this.opts.onClose();
    this.contentEl.empty();
  }
}

/**
 * Shows the active key so it can be copied to a password manager or another device.
 *
 * Separate from `BackupKeyModal` because it grants nothing and gates nothing: the same key,
 * shown on request. It exists because this used to be a `Notice`, which is the one container
 * a secret must not go in — it cannot be selected on a phone, it stays on top of the page
 * until dismissed, and it is the part of the screen people photograph.
 */
export class RevealKeyModal extends Modal {
  constructor(
    app: App,
    private readonly key: string
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Vault master key" });
    contentEl.createEl("p", {
      text:
        "Every device on this vault needs this exact key, and no snapshot can be read " +
        "without it. Keep it in a password manager — not in a note in this vault, which is " +
        "the thing it protects.",
    });
    const field = secretField(contentEl, this.key, "Vault master key");
    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText("Copy key")
          .setCta()
          .onClick(() => copySecret(this.key, field, "Vault master key"))
      )
      .addButton((b) => b.setButtonText("Close").onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Derives once, then hands only the derived key to the normal backup/migration gate. */
class PassphraseKeyModal extends Modal {
  #passphrase = "";
  #confirmation = "";
  #salt: string;

  constructor(
    app: App,
    private readonly opts: {
      initialSalt: string;
      onDerived: (key: string, vaultSalt: string) => void;
    }
  ) {
    super(app);
    this.#salt = opts.initialSalt;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Derive a key from a passphrase" });
    contentEl.createEl("p", {
      text:
        "Anyone with a copy of the bucket can try guesses offline. Use a long, unique " +
        "passphrase; a weak one defeats end-to-end encryption. A random key remains safer.",
    });
    new Setting(contentEl).setName("Passphrase").addText((text) => {
      text.inputEl.type = "password";
      text.onChange((value) => (this.#passphrase = value));
    });
    new Setting(contentEl).setName("Confirm passphrase").addText((text) => {
      text.inputEl.type = "password";
      text.onChange((value) => (this.#confirmation = value));
    });
    new Setting(contentEl)
      .setName("Vault salt")
      .setDesc("Public vault-wide value. Copy it with the derived key for manual recovery.")
      .addText((text) => text.setValue(this.#salt).onChange((value) => (this.#salt = value.trim())));

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText("Derive key")
          .setCta()
          .onClick(async () => {
            if (this.#passphrase === "") {
              new Notice("Passphrase must not be empty", 10_000);
              return;
            }
            if (this.#passphrase !== this.#confirmation) {
              new Notice("Passphrases do not match", 10_000);
              return;
            }
            button.setDisabled(true);
            try {
              parseVaultSalt(this.#salt);
              const derived = await deriveMasterKeyFromPassphrase(this.#passphrase, this.#salt);
              const salt = this.#salt;
              this.#passphrase = "";
              this.#confirmation = "";
              this.close();
              this.opts.onDerived(derived, salt);
            } catch (error) {
              button.setDisabled(false);
              new Notice(`Could not derive the key: ${message(error)}`, 10_000);
            }
          })
      )
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
  }

  onClose(): void {
    this.#passphrase = "";
    this.#confirmation = "";
    this.contentEl.empty();
  }
}

/**
 * Hands this device's credentials to a new one, as a scannable code or as a copyable link.
 *
 * The link is not a convenience duplicate of the QR. Scanning is what delivers the payload,
 * so a QR-only export can only reach devices that can point a camera at this screen: desktop
 * to desktop had no route at all, and the "copy the setup link" the docs told people to use
 * only existed when a phone scanner mis-routed `obsidian://` into a browser — a failure path
 * dressed up as a feature.
 */
export class DeviceSetupModal extends Modal {
  #name = "phone";
  #token: string;

  constructor(
    app: App,
    private readonly plugin: LogSyncPlugin
  ) {
    super(app);
    // Default to sharing this device's token: the server uses tokens only to authenticate,
    // so one shared token works everywhere and rotation is mint-new + revoke-old. A
    // A separately named access token is the opt-in for individually locking out a lost device.
    this.#token = plugin.settings.accessToken;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Set up another device" });
    contentEl.createEl("p", {
      text:
        "Both the code and the link carry the server URL, the vault access token and the " +
        "master key. Scan the code from a phone; copy the link for a device that cannot " +
        "scan one, such as a second computer. Give the new device its own name — that is " +
        "how conflict copies say where they came from.",
    });

    // Three containers up front so the export can sit between the fields and the buttons and
    // still be reachable from the fields' change handlers, which is what lets an edited field
    // discard it. A code left on screen after the name or token changed describes a payload
    // the page no longer shows, and the next scan hands over the stale one.
    const fields = contentEl.createDiv();
    const out = contentEl.createDiv();
    const actions = contentEl.createDiv();

    new Setting(fields)
      .setName("New device name")
      .addText((t) =>
        t.setValue(this.#name).onChange((v) => {
          this.#name = v.trim();
          out.empty();
        })
      );

    new Setting(fields)
      .setName("Token")
      .setDesc(
        "Sharing this device's token is fine. To be able to lock out ONE device later " +
          "(a phone that might get lost), mint it a token of its own with " +
          "scripts/access-token.mjs --name phone and paste that here instead."
      )
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(this.#token).onChange((v) => {
          this.#token = v.trim();
          out.empty();
        });
      });

    new Setting(actions)
      .addButton((b) =>
        b
          .setButtonText("Show QR")
          .setCta()
          .onClick(() => this.#render(out))
      )
      // Returns the promise rather than discarding it: Obsidian ignores it, but a test that
      // cannot await the copy can only assert on whatever happened to have settled by then.
      .addButton((b) => b.setButtonText("Copy setup link").onClick(() => this.#copy(out)));
  }

  /**
   * The payload both exports share, or null with the reason said out loud. Building it in one
   * place is what keeps the link and the code from ever describing different vaults.
   */
  #payload(): SetupPayload | null {
    if (!this.plugin.settings.serverUrl) {
      new Notice("Set the server URL in settings first");
      return null;
    }
    if (!this.#token) {
      new Notice("No token to share — set the access token in settings first");
      return null;
    }
    // Handing the key to a second device is not a backup, and it must not be able to pass
    // for one. Without this the acknowledgement is laundered away by transit: this device
    // exports a key it never saved, `applySetup` records it as backed up on the recipient,
    // and the invariant the gate exists for — one durable copy exists somewhere — is gone.
    if (this.plugin.encryptionEnabled && !this.plugin.settings.masterKeyBackedUp) {
      new Notice(
        "Back up the vault master key before sharing it. Sending it to another device is " +
          "not a backup — both could be lost. Finish the key backup in settings first.",
        10_000
      );
      return null;
    }

    const common = {
      v: 2 as const,
      url: this.plugin.settings.serverUrl,
      name: this.#name || "device",
      token: this.#token,
    };
    const payload: SetupPayload = this.plugin.encryptionEnabled
      ? {
          ...common,
          mode: "encrypted",
          key: this.plugin.settings.masterKey.trim(),
          vaultSalt: this.plugin.settings.vaultSalt,
        }
      : { ...common, mode: "plaintext" };

    // Prove the receiving side will accept this before promising the user it is usable.
    // Running the real parser rather than re-checking the fields here is what stops export
    // and import from ever drifting apart, and it names the offending field for free — the
    // alternative is a failure that surfaces on the *other* device, minutes later.
    try {
      decodeSetupPayload(encodeSetupPayload(payload));
    } catch (error) {
      new Notice(
        `This device cannot produce a usable setup link yet: ${message(error)}. Finish ` +
          "setting it up — or fix its settings — and try again.",
        0
      );
      return null;
    }
    return payload;
  }

  #warn(out: HTMLElement, medium: string): void {
    out.createEl("p", {
      text: this.plugin.encryptionEnabled
        ? `This ${medium} contains the access token AND the vault master key. Anyone who gets it gains full access — give it only to your own device.`
        : `This ${medium} contains the access token. Anyone who gets it can write to your vault.`,
    });
  }

  #render(out: HTMLElement): void {
    out.empty();
    const payload = this.#payload();
    if (payload === null) return;

    this.#warn(out, "QR");
    renderQr(out, encodeSetupUri(payload));
    out.createEl("p", {
      text: "On the other device: open the camera app, scan, and confirm when Obsidian opens.",
    });
  }

  async #copy(out: HTMLElement): Promise<void> {
    out.empty();
    const payload = this.#payload();
    if (payload === null) return;

    const uri = encodeSetupUri(payload);
    this.#warn(out, "link");
    try {
      await navigator.clipboard.writeText(uri);
      new Notice("Setup link copied. Paste it into the new device with \"Apply a setup link\".");
      out.createEl("p", {
        text:
          "Copied. On the other device: Settings → R2DO Sync → Apply a setup link → Paste " +
          "link. Clear your clipboard afterwards.",
      });
    } catch (error) {
      // A clipboard the platform refuses must not leave the user with no route at all — the
      // whole point of the link is reaching a device that cannot scan the code.
      new Notice(`Could not copy the link: ${message(error)}. Select and copy it manually.`, 10_000);
      const field = out.createEl("textarea");
      field.value = uri;
      field.readOnly = true;
      field.rows = 3;
      field.setAttr("aria-label", "Setup link");
      field.focus();
      field.select();
    }
  }

  onClose(): void {
    // Drop the secrets from memory along with the rendered code.
    this.#token = "";
    this.contentEl.empty();
  }
}

/** Mobile side of QR setup: confirm before overwriting settings. */
export class ApplySetupModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: LogSyncPlugin,
    private readonly payload: SetupPayload
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Apply R2DO Sync setup?" });
    contentEl.createEl("p", { text: `Server: ${this.payload.url}` });
    contentEl.createEl("p", { text: `Device name: ${this.payload.name}` });
    contentEl.createEl("p", {
      text: this.payload.mode === "encrypted"
        ? "Includes a vault master key (end-to-end encryption on)."
        : "No master key included — the vault will sync unencrypted.",
    });

    // Repointing a working device at a different vault is the one case where this dialog is
    // consequential, and a flat "replaces the current server, token and key" reads identically
    // on a device that has none. Name both ends so the difference is on the page.
    const current = this.plugin.settings.serverUrl.trim();
    const moving = current !== "" && endpointIdentity(current) !== endpointIdentity(this.payload.url);
    contentEl.createEl("p", {
      text: moving
        ? `This device currently syncs with ${current}. Applying this link points it at ` +
          `${this.payload.url} instead — a different vault, holding different files.`
        : "This replaces the current server, token and key on this device.",
    });
    if (moving) {
      contentEl.createEl("p", {
        text:
          "Nothing local is deleted now, and the next pass asks before it reconciles this " +
          "vault against the new server for the first time.",
      });
    }

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText("Apply")
          .setCta()
          .onClick(async () => {
            this.close();
            try {
              await this.plugin.applySetup(this.payload);
            } catch (error) {
              // The window is already gone, so an unhandled rejection here is silence: the
              // device looks configured and is not. `applySetup` catches its own connection
              // test, which is the tell that failures were meant to be visible.
              new Notice(`R2DO Sync could not apply the setup link: ${message(error)}`, 0);
            }
          })
      )
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * The way onto a phone when the camera hands the QR to a browser instead of Obsidian.
 *
 * The scanned-link path relies on the OS routing `obsidian://` to the app, and plenty of
 * scanners simply do not. Without a paste route, a phone in that situation has no way to be
 * set up at all except retyping a 64-character token and a master key by hand — which is
 * exactly the silent-misconfiguration risk the QR exists to remove.
 */
export class PasteSetupModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: LogSyncPlugin
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Apply a setup link" });
    contentEl.createEl("p", {
      text:
        "On the configured device use \"Set up another device\" → \"Copy setup link\", then " +
        "paste it here. It carries the server URL, the access token and the master key, so " +
        "treat it like a password and clear your clipboard afterwards.",
    });

    let text = "";
    let field: HTMLTextAreaElement | null = null;
    new Setting(contentEl).setName("Setup link").addTextArea((t) => {
      field = t.inputEl;
      t.setPlaceholder(`obsidian://${SETUP_ACTION}?d=…`).onChange((v) => {
        text = v;
      });
    });

    // Styled as an error, because a page that looks identical whether or not it just refused
    // something has not told the user anything.
    const error = contentEl.createEl("p", { text: "", cls: "r2do-error" });
    const fail = (said: string) => error.setText(said);

    const advance = (): void => {
      try {
        // Parse before closing: an unusable paste must say why, in place, rather
        // than dismissing the dialog and leaving the device unconfigured.
        const payload = parseSetupText(text);
        this.close();
        new ApplySetupModal(this.app, this.plugin, payload).open();
      } catch (e) {
        fail(`Cannot use that link: ${message(e)}`);
      }
    };

    new Setting(contentEl)
      // The link is already on the clipboard — that is how it got to this device. Reading it
      // here is one tap instead of a long-press paste into a field, which is the difference
      // between routes on a phone, where this window is the main way in.
      .addButton((b) =>
        b.setButtonText("Paste from clipboard").onClick(async () => {
          let read: string;
          try {
            read = await navigator.clipboard.readText();
          } catch (e) {
            fail(`Could not read the clipboard: ${message(e)}. Paste into the field instead.`);
            return;
          }
          text = read;
          if (field !== null) field.value = read;
          advance();
        })
      )
      .addButton((b) => b.setButtonText("Continue").setCta().onClick(advance))
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class LogSyncSettingTab extends PluginSettingTab {
  /**
   * Fields that stage their value until they lose focus, so the page can flush them if it
   * closes first. Rebuilt by every `display()`, because the controls are.
   */
  #pending: Array<() => void> = [];

  constructor(
    app: App,
    private readonly plugin: LogSyncPlugin
  ) {
    super(app, plugin);
  }

  /** Section title. `setHeading()` rather than a hand-rolled `<h3>`, which no theme styles. */
  #heading(containerEl: HTMLElement, text: string): void {
    new Setting(containerEl).setName(text).setHeading();
  }

  /**
   * Commits a staged field on blur, on Enter, and once more if the page closes while it is
   * still focused.
   *
   * Saving per keystroke stores every prefix of what is being typed: each one rebuilds the
   * engine, and for a value with a guard behind it — `protectPercent` — typing "100" over a
   * 50 stores 1, then 10, and raises the "turn the guard off?" modal in the middle of the
   * word. Every commit here is idempotent (unchanged input returns early), so blur followed
   * by the close-flush costs nothing.
   */
  #stage(input: HTMLElement, commit: () => void | Promise<void>, commitOnEnter = true): void {
    input.addEventListener("blur", () => void commit());
    if (commitOnEnter) {
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") void commit();
      });
    }
    this.#pending.push(() => void commit());
  }

  /** Obsidian closes the tab without blurring the focused field. Do not lose what it holds. */
  hide(): void {
    const pending = this.#pending;
    this.#pending = [];
    for (const flush of pending) flush();
  }

  /**
   * A numeric setting that stores what it can use, and says so when it cannot.
   *
   * Out-of-range input is refused rather than rounded: the stored value only ever changes to
   * something inside the documented range. Refusals are announced — the field silently
   * disagreeing with what is stored looks exactly like a value that was accepted.
   */
  #number(
    containerEl: HTMLElement,
    opts: {
      name: string;
      desc: string;
      value: number;
      /** Accepted range in words, used verbatim when a value is refused. */
      range: string;
      accept: (n: number) => boolean;
      apply: (n: number) => void;
      /** A second look before a value that switches a protection off. False keeps the old one. */
      confirm?: (n: number) => Promise<boolean>;
    }
  ): void {
    new Setting(containerEl)
      .setName(opts.name)
      .setDesc(opts.desc)
      .addText((t) => {
        let stored = opts.value;
        t.setValue(String(stored));
        this.#stage(t.inputEl, async () => {
          const raw = t.inputEl.value.trim();
          if (raw === String(stored)) return;
          const n = Number(raw);
          if (raw === "" || !Number.isInteger(n) || !opts.accept(n)) {
            t.setValue(String(stored));
            new Notice(`${opts.name} takes ${opts.range}. Keeping ${stored}.`, 8000);
            return;
          }
          if (opts.confirm !== undefined && !(await opts.confirm(n))) {
            t.setValue(String(stored));
            return;
          }
          opts.apply(n);
          stored = n;
          t.setValue(String(stored));
          await this.plugin.saveSettings();
        });
      });
  }

  /**
   * "Sync hotkey" — read the binding, and offer one when that is safe.
   *
   * The plugin claims no key of its own: Obsidian's API docs advise plugins against default
   * hotkeys because they collide with the user's and with other plugins. So the one-click offer
   * appears only on an explicit click, and only when the suggested keystroke is *provably* free.
   * Every read can come back "cannot tell" (the hotkey manager is undocumented internals), and
   * then the row says where to go instead of guessing at a binding.
   */
  #hotkeyRow(containerEl: HTMLElement): void {
    const isMac = Platform.isMacOS === true;
    const commandId = this.plugin.syncCommandId;
    const query = this.plugin.hotkeySearchQuery;
    const manually = `Open Settings → Hotkeys and search "${query}".`;
    const bound = boundHotkeys(this.app, commandId);
    const bindings = allHotkeys(this.app);
    const suggestion = formatHotkey(SUGGESTED_SYNC_HOTKEY, isMac);
    const taken =
      bindings === null
        ? null
        : findBindingConflicts(bindings, SUGGESTED_SYNC_HOTKEY, [commandId], isMac);

    const state =
      bound === null
        ? `This device's bindings could not be read. ${manually}`
        : bound.length > 0
          ? `Currently ${formatBindings(bound, isMac)}, which runs the same pass as the ribbon icon.`
          : 'Not set. "Sync now" runs the same pass as the ribbon icon, and every other action ' +
            "on this page can take a key of its own in Settings → Hotkeys.";
    const clash =
      taken !== null && taken.length > 0
        ? ` ${suggestion} is already used by ${taken.length} other command${taken.length === 1 ? "" : "s"}, so pick your own.`
        : "";

    const row = new Setting(containerEl).setName("Sync hotkey").setDesc(state + clash);

    const free = bound !== null && bound.length === 0 && taken !== null && taken.length === 0;
    if (free) {
      row.addButton((b) =>
        b
          .setButtonText(`Use ${suggestion}`)
          .setCta()
          .onClick(() => {
            if (!assignHotkey(this.app, commandId, SUGGESTED_SYNC_HOTKEY)) {
              new Notice(`R2DO Sync could not set the hotkey. ${manually}`, 10_000);
              return;
            }
            new Notice(`R2DO Sync: ${suggestion} now starts a sync.`);
            this.display();
          })
      );
    }

    row.addButton((b) =>
      b
        .setButtonText(bound !== null && bound.length > 0 ? "Change" : "Choose")
        .onClick(() => {
          if (!openHotkeySettings(this.app, query)) new Notice(manually, 10_000);
        })
    );
  }

  /**
   * What a fresh install sees instead of two unexplained credential fields.
   *
   * The two ways in are not interchangeable and the difference is invisible from the fields
   * alone: only a setup link or QR carries the vault's master key, so a second device that is
   * configured by hand mints a key of its own and is refused at the first pass. That used to
   * be discoverable only by hitting it, since the cure lived in a banner that appears *after*
   * the failure. Leading with both routes puts the choice before the mistake.
   */
  #renderFirstRun(containerEl: HTMLElement): void {
    this.#heading(containerEl, "Set up sync");
    containerEl.createEl("p", {
      text:
        "This device is not connected to a vault yet. There are two ways in, and they are " +
        "not interchangeable.",
    });

    new Setting(containerEl)
      .setName("Join a vault that already syncs")
      .setDesc(
        "A server URL and access token typed in by hand cannot join an encrypted vault: they " +
          "do not carry the master key, so this device would mint a key of its own and be " +
          "refused at the first pass. Bring the key across instead."
      )
      .addButton((b) =>
        b
          .setButtonText("Paste setup link")
          .setCta()
          .onClick(() => new PasteSetupModal(this.app, this.plugin).open())
      );

    // Short paragraphs with the path in bold, because this is a procedure to follow on another
    // device while reading it here — six sentences in a row is not something anyone follows.
    const join = containerEl.createEl("p");
    join.appendText("On the device that already syncs, open ");
    join.createEl("strong", { text: "Settings → R2DO Sync → Set up another device" });
    join.appendText(
      ". Scan the QR with this device's camera, or press \"Copy setup link\" there and paste " +
        "it with the button above — that is the route for a second computer, which has " +
        "nothing to scan with."
    );

    const first = containerEl.createEl("p");
    first.appendText("Setting up the first device instead? Run ");
    first.createEl("strong", { text: "scripts/setup.mjs" });
    first.appendText(" from the ");
    first.createEl("a", { text: "project repository", href: REPO_URL });
    first.appendText(
      " on a computer, then paste the server URL and access token it prints into the fields " +
        "below. This device then generates the vault's master key and asks you to save it " +
        "before anything is uploaded."
    );

    containerEl.createEl("p", {
      text: dataResponsibility(this.plugin.settings.encryptionMode),
      cls: "r2do-disclaimer",
    });
  }

  /**
   * How this plugin behaves, at the top where it is read.
   *
   * This used to be the last paragraph on the page, below "Advanced" — the best orientation
   * text here, placed where someone deciding whether to trust the thing would never reach it.
   */
  #renderOverview(containerEl: HTMLElement): void {
    containerEl.createEl("p", {
      text:
        "Two-way sync: changes from other devices are pulled and merged into this vault " +
        "before anything is uploaded. Notes that both devices edited in the same place are " +
        "never merged blindly — the other version is saved as a .conflict-… copy beside " +
        "yours. Sync halts only if the remote is unreadable with this device's master key, " +
        "and pauses to ask if a pull would destroy a large share of this vault. Every " +
        "snapshot stays restorable from Snapshot history until the server's retention " +
        "policy trims it.",
    });
  }

  /**
   * Saves a credential, and re-renders only when the page's shape actually changed.
   *
   * An unconfigured device shows a short page; completing the pair earns the rest of it. The
   * re-render is conditional because it destroys the controls, and doing that on every commit
   * would pull the page out from under someone tabbing between the two fields.
   */
  async #commitCredential(apply: () => void): Promise<void> {
    const wasUnconfigured = isUnconfigured(this.plugin.settings);
    apply();
    await this.plugin.saveSettings();
    if (isUnconfigured(this.plugin.settings) !== wasUnconfigured) this.display();
  }

  #renderConnection(containerEl: HTMLElement): void {
    this.#heading(containerEl, "Connection");

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("Base URL of the sync Worker, e.g. https://obsidian-log-sync.<sub>.workers.dev")
      .addText((t) => {
        let stored = this.plugin.settings.serverUrl;
        t.setValue(stored);
        this.#stage(t.inputEl, async () => {
          const entered = t.inputEl.value.trim();
          if (entered === stored) return;
          let next: string;
          try {
            next = entered === "" ? "" : normalizeServerUrl(entered);
          } catch (e) {
            t.setValue(stored);
            new Notice(`R2DO Sync server URL rejected: ${message(e)}`, 10_000);
            return;
          }
          stored = next;
          t.setValue(next);
          await this.#commitCredential(() => {
            this.plugin.settings.serverUrl = next;
          });
        });
      });

    // Declare first, then add controls. A component callback runs synchronously inside
    // addText(), so chaining it onto the declaration reads the const before it is bound —
    // a TDZ ReferenceError that aborted display() and hid every setting below this one.
    const tokenSetting = new Setting(containerEl)
      .setName("Access token")
      .setDesc(
        "Printed by scripts/setup.mjs. One token authenticates this vault and every device " +
          "can share it; re-issue or revoke it with scripts/access-token.mjs. Never the admin token."
      );
    tokenSetting.addText((t) => {
      t.inputEl.type = "password";
      let stored = this.plugin.settings.accessToken;
      t.setValue(stored);
      addReveal(tokenSetting, t.inputEl);
      this.#stage(t.inputEl, async () => {
        const entered = t.inputEl.value.trim();
        if (entered === stored) return;
        stored = entered;
        t.setValue(entered);
        await this.#commitCredential(() => {
          this.plugin.settings.accessToken = entered;
        });
      });
    });

    // Beside the two fields it tests. It was at the bottom of "Advanced", a page away from
    // the only two values it can tell you anything about, and it is a first-run tool.
    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Checks the URL and token against the server.")
      .addButton((b) =>
        b.setButtonText("Test").onClick(async () => {
          try {
            const api = new SyncApi({
              baseUrl: this.plugin.settings.serverUrl,
              token: this.plugin.settings.accessToken,
              http: obsidianHttp,
            });
            const head = await api.getHead();
            new Notice(`R2DO Sync OK. Remote head: ${head ?? "(empty vault)"}`);
          } catch (e) {
            new Notice(`R2DO Sync failed: ${message(e)}`, 10_000);
          }
        })
      );
  }

  #deviceNameRow(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Device name")
      .setDesc("Recorded in each commit so you can tell devices apart in history.")
      .addText((t) => {
        let stored = this.plugin.settings.deviceName;
        t.setValue(stored);
        this.#stage(t.inputEl, async () => {
          const next = t.inputEl.value.trim() || "device";
          if (next === stored) return;
          stored = next;
          t.setValue(next);
          this.plugin.settings.deviceName = next;
          await this.plugin.saveSettings();
        });
      });
  }

  #renderThisDevice(containerEl: HTMLElement): void {
    this.#heading(containerEl, "This device");
    this.#deviceNameRow(containerEl);

    const hasKey = this.plugin.settings.masterKey.trim() !== "";
    const blockedReason = isUnconfigured(this.plugin.settings)
      ? "Set the server URL and access token first — there is nothing to hand over yet."
      : this.plugin.encryptionEnabled && !hasKey
        ? "Waiting for this device's master key to be generated."
        : this.plugin.encryptionEnabled && !this.plugin.settings.masterKeyBackedUp
          ? "Back up the vault master key first. Sending it to another device is not a backup."
          : null;
    new Setting(containerEl)
      .setName("Set up another device")
      .setDesc(
        blockedReason ??
          "Hands the server URL, an access token and the master key to a new device — as a " +
            "QR code to scan from a phone, or as a link to paste into one that cannot scan."
      )
      .addButton((b) =>
        b
          .setButtonText("Set up device")
          // Offering a window whose every button can only refuse is a dead end dressed as
          // an action. The reason belongs in the description, not in a notice after a click.
          .setDisabled(blockedReason !== null)
          .onClick(() => new DeviceSetupModal(this.app, this.plugin).open())
      );

    new Setting(containerEl)
      .setName("Apply a setup link")
      .setDesc(
        "Paste a setup link copied from another device. Use this when scanning the QR opens " +
          "a browser instead of Obsidian — common on phones."
      )
      .addButton((b) =>
        b.setButtonText("Paste link").onClick(() => new PasteSetupModal(this.app, this.plugin).open())
      );
  }

  #renderEncryption(containerEl: HTMLElement): void {
    this.#heading(containerEl, "Encryption");
    containerEl.createEl("p", {
      text:
        "Encryption is the default. File contents and paths are encrypted before upload, " +
        "and sync cannot start until the key backup is acknowledged. Random keys are " +
        "recommended; a passphrase-derived key is available when memory recovery matters.",
    });

    const requestEncryptedTarget = (key: string, vaultSalt: string) => {
      const run = () => this.plugin.requestEncryptionTarget("encrypted", key, vaultSalt);
      const changesActive =
        this.plugin.hasSyncedSnapshot &&
        (!this.plugin.encryptionEnabled || key.trim() !== this.plugin.settings.masterKey.trim());
      if (!changesActive) {
        run();
        return;
      }
      new ConfirmModal(this.app, {
        title: this.plugin.encryptionEnabled ? "Replace the vault master key?" : "Encrypt this vault now?",
        body:
          "Every file in the current remote snapshot will be authenticated, transformed, " +
          "and uploaded under the new key in one explicit migration. Other devices halt " +
          "until they receive the same key. Local files are not rewritten.",
        phrase: "REKEY",
        onConfirm: run,
      }).open();
    };

    // `masterKey` is empty until the engine generates one, which is a state with its own
    // description: the old text told a brand-new device that sync was blocked on backing up
    // a key that did not exist yet, beside an empty field.
    const hasKey = this.plugin.settings.masterKey.trim() !== "";
    const keyDesc = !this.plugin.encryptionEnabled
      ? "Plaintext was explicitly selected. Paste a key here to encrypt the vault."
      : !hasKey
        ? "A random key is generated for this vault as soon as the server URL and access " +
          "token are in place, and shown for you to save before anything is uploaded."
        : this.plugin.settings.masterKeyBackedUp
          ? "Encryption is ON and the backup gate is complete. Paste only to stage an explicit re-key."
          : "Encryption is ON but sync is blocked until you back up and acknowledge this key.";

    // Same two-step shape as the access-token field, for the same TDZ reason.
    const keySetting = new Setting(containerEl).setName("Vault master key").setDesc(keyDesc);
    keySetting
      .addText((t) => {
        const previous = this.plugin.settings.masterKey;
        t.inputEl.type = "password";
        t.setPlaceholder("base64, 32 bytes");
        t.setValue(previous);
        addReveal(keySetting, t.inputEl);

        // Stage on blur, never per keystroke. The active key is not mutated until the
        // backup gate and (for an established vault) explicit CAS migration both succeed.
        t.inputEl.addEventListener("blur", () => {
          const next = t.inputEl.value.trim();
          if (next === previous) return;
          if (next === "") {
            t.setValue(previous);
            new Notice('Use "Turn off encryption" so plaintext mode cannot be selected accidentally.', 10_000);
            return;
          }
          const salt = this.plugin.settings.vaultSalt || generateVaultSalt();
          requestEncryptedTarget(next, salt);
          t.setValue(previous);
        });
      })
      .addButton((b) =>
        b
          .setButtonText("Generate")
          .setWarning()
          .onClick(() => {
            requestEncryptedTarget(
              generateMasterKey(),
              this.plugin.settings.vaultSalt || generateVaultSalt()
            );
          })
      )
      .addButton((b) =>
        b.setButtonText("Set from passphrase").onClick(() =>
          new PassphraseKeyModal(this.app, {
            initialSalt: this.plugin.settings.vaultSalt || generateVaultSalt(),
            onDerived: requestEncryptedTarget,
          }).open()
        )
      );

    if (this.plugin.encryptionEnabled && hasKey && !this.plugin.settings.masterKeyBackedUp) {
      new Setting(containerEl)
        .setName("Key backup required")
        .setDesc("Sync is disabled until the generated or derived key is saved.")
        .addButton((b) => b.setButtonText("Back up now").setCta().onClick(() =>
          this.plugin.requestEncryptionTarget(
            "encrypted",
            this.plugin.settings.masterKey,
            this.plugin.settings.vaultSalt || generateVaultSalt()
          )
        ));
    }

    if (this.plugin.encryptionEnabled && hasKey) {
      new Setting(containerEl)
        .setName("Reveal master key")
        .setDesc("Shows the key so you can back it up or copy it to another device.")
        .addButton((b) =>
          // A window, not a notice: a secret has to be selectable and copyable, and a notice
          // is neither on a phone. It also floats over the page until it is dismissed.
          b.setButtonText("Reveal").onClick(() =>
            new RevealKeyModal(this.app, this.plugin.settings.masterKey).open()
          )
        );

      new Setting(containerEl)
        .setName("Turn off encryption")
        .setDesc("Transforms the complete remote snapshot to plaintext. This is not recommended.")
        .addButton((b) =>
          b.setButtonText("Use plaintext").setWarning().onClick(() => {
            new ConfirmModal(this.app, {
              title: "Turn off encryption?",
              body:
                "Every file path and content blob will become readable to the storage " +
                "provider. The complete remote snapshot must be transformed and re-uploaded.",
              phrase: "REKEY",
              onConfirm: () => this.plugin.requestEncryptionTarget("plaintext", "", ""),
            }).open();
          })
        );
    }
  }

  /**
   * Every file Obsidian has indexed, or null when that cannot be read.
   *
   * The index is the only source cheap enough to consult while someone types: a true scan
   * stats every file in the vault, which is a sync's job. It also holds no hidden files, so
   * the counts built from it say "indexed" rather than "in this vault". A partly-built App
   * has no index at all, and then the page shows no count instead of a wrong one.
   */
  #indexedPaths(): string[] | null {
    const vault: Partial<Vault> | undefined = this.app.vault;
    if (typeof vault?.getFiles !== "function") return null;
    return vault.getFiles().map((file) => file.path);
  }

  #renderScope(containerEl: HTMLElement): void {
    this.#heading(containerEl, "What syncs");

    // Drafts, not settings: the count has to follow what is being typed, while the setting
    // itself is only written on blur — a half-finished glob must never be the live rule.
    let onlyDraft = this.plugin.settings.onlyPaths;
    let excludeDraft = this.plugin.settings.excludes;
    const indexed = this.#indexedPaths();
    let onlyHint: HTMLElement | null = null;
    let excludeHint: HTMLElement | null = null;
    const refresh = (): void => {
      if (indexed === null) return;
      const rules = {
        excludes: parseGlobs(excludeDraft),
        onlyPaths: parseGlobs(onlyDraft),
        syncConfigDir: this.plugin.settings.syncConfigDir,
      };
      const kept = countInScope(indexed, rules);
      const unexcluded = countInScope(indexed, { ...rules, excludes: [] });
      const dropped = unexcluded - kept;
      onlyHint?.setText(
        rules.onlyPaths.length === 0
          ? `No allow-list: ${kept} of ${indexed.length} files in Obsidian's index sync. Hidden files are not counted here.`
          : `Allow-list matches ${kept} of ${indexed.length} files in Obsidian's index. Hidden files are not counted here.`
      );
      excludeHint?.setText(
        `Excludes drop ${dropped} file${dropped === 1 ? "" : "s"} of the ${unexcluded} that would otherwise sync.`
      );
    };

    new Setting(containerEl)
      .setName("Only sync matching paths")
      .setDesc("Optional allow-list, one glob per line. Empty means the whole vault. Non-matching remote paths are carried, never deleted.")
      .addTextArea((t) => {
        t.inputEl.addClass("r2do-globs");
        t.setValue(onlyDraft).onChange((v) => {
          onlyDraft = v;
          refresh();
        });
        this.#stage(
          t.inputEl,
          async () => {
            if (onlyDraft === this.plugin.settings.onlyPaths) return;
            this.plugin.settings.onlyPaths = onlyDraft;
            await this.plugin.saveSettings();
          },
          false
        );
      });
    if (indexed !== null) onlyHint = containerEl.createDiv({ cls: "r2do-hint" });

    new Setting(containerEl)
      .setName("Exclude globs")
      .setDesc("One per line. Supports * and **.")
      .addTextArea((t) => {
        t.inputEl.addClass("r2do-globs");
        t.setValue(excludeDraft).onChange((v) => {
          excludeDraft = v;
          refresh();
        });
        this.#stage(
          t.inputEl,
          async () => {
            if (excludeDraft === this.plugin.settings.excludes) return;
            this.plugin.settings.excludes = excludeDraft;
            await this.plugin.saveSettings();
          },
          false
        );
      });
    if (indexed !== null) excludeHint = containerEl.createDiv({ cls: "r2do-hint" });
    refresh();

    new Setting(containerEl)
      .setName("Sync Obsidian configuration directory")
      .setDesc("Includes .obsidian/** except this plugin's live/legacy credential directories and workspace files. Bad config merges can break plugins.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncConfigDir).onChange((enabled) => {
          if (!enabled) {
            this.plugin.settings.syncConfigDir = false;
            void this.plugin.saveSettings();
            return;
          }
          toggle.setValue(false);
          new ConfirmModal(this.app, {
            title: "Sync Obsidian configuration files?",
            body:
              "Plugin settings and configuration JSON are not mergeable like notes. A bad " +
              "cross-device overwrite can disable plugins or corrupt configuration. R2DO " +
              "Sync still excludes its own credentials and workspace layouts.",
            phrase: "SYNC CONFIG",
            onConfirm: async () => {
              this.plugin.settings.syncConfigDir = true;
              await this.plugin.saveSettings();
              this.display();
            },
            onCancel: () => toggle.setValue(false),
          }).open();
        })
      );

    new Setting(containerEl)
      .setName("Sync direction")
      .setDesc("Two-way merges both sides. Pull-only never commits. Push-only never writes local files and preserves remote conflicts in the snapshot.")
      .addDropdown((d) =>
        d
          .addOption("two-way", "Two-way")
          .addOption("pull-only", "Pull-only")
          .addOption("push-only", "Push-only (backup)")
          .setValue(this.plugin.settings.syncMode)
          .onChange(async (value) => {
            this.plugin.settings.syncMode = value as SyncMode;
            await this.plugin.saveSettings();
          })
      );
  }

  #renderSchedule(containerEl: HTMLElement): void {
    this.#heading(containerEl, "When it syncs");

    this.#number(containerEl, {
      name: "Debounce (seconds)",
      desc: "How long edits must settle before a push.",
      value: this.plugin.settings.debounceSeconds,
      range: "0–3600",
      accept: (n) => n >= 0 && n <= 3600,
      apply: (n) => {
        this.plugin.settings.debounceSeconds = n;
      },
    });

    this.#number(containerEl, {
      name: "Periodic sync (minutes)",
      desc: "0 disables. A change takes effect immediately.",
      value: this.plugin.settings.intervalMinutes,
      range: "0–1440",
      accept: (n) => n >= 0 && n <= 1440,
      apply: (n) => {
        this.plugin.settings.intervalMinutes = n;
      },
    });

    new Setting(containerEl)
      .setName("Sync on startup")
      .setDesc(
        "Runs one pass when Obsidian opens this vault, and on mobile again each time you " +
          "return to the app — where a backgrounded app gets no timers, so this is what keeps " +
          "a phone current."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncOnStartup).onChange(async (v) => {
          this.plugin.settings.syncOnStartup = v;
          await this.plugin.saveSettings();
        })
      );

    // A row about keystrokes on a device with no keyboard is noise: mobile Obsidian has no
    // Hotkeys page to send anyone to either.
    if (!Platform.isMobile) this.#hotkeyRow(containerEl);
  }

  #renderSafety(containerEl: HTMLElement): void {
    this.#heading(containerEl, "Safety");

    this.#number(containerEl, {
      name: "Ask before large changes (%)",
      desc:
        "If a pull would delete or overwrite MORE than this share of the files this device " +
        "syncs, sync pauses and asks which side to keep. At or below it, changes merge " +
        "automatically — anything that cannot be merged is still kept as a .conflict-… " +
        "copy, so nothing is lost by not asking. 100 turns the check off.",
      value: this.plugin.settings.protectPercent,
      range: "whole numbers 0–100",
      accept: (n) => n >= 0 && n <= 100,
      apply: (n) => {
        this.plugin.settings.protectPercent = n;
      },
      // 100 is not a threshold, it is the off switch — worth a second look.
      confirm: (n) =>
        n !== 100
          ? Promise.resolve(true)
          : new Promise<boolean>((resolve) => {
              new ConfirmModal(this.app, {
                title: "Turn off the mass-change guard?",
                body:
                  "At 100 a pull may delete or replace every file on this device without " +
                  "asking. The guard exists for the day a mistaken or malicious remote " +
                  "snapshot arrives; snapshots stay restorable, but only if you notice.",
                confirmText: "Turn it off",
                cancelText: "Keep the guard",
                onConfirm: () => resolve(true),
                onCancel: () => resolve(false),
              }).open();
            }),
    });

    new Setting(containerEl)
      .setName("Conflict handling")
      .setDesc(
        "What happens when both sides changed a file in ways that cannot be merged. " +
          '"Keep both" parks the losing version beside the winner as a .conflict-… copy. ' +
          "The overwrite modes pick a winner (same result on every device) and DISCARD " +
          "the loser."
      )
      .addDropdown((d) => {
        d.addOption("keep-both", "Keep both (recommended)")
          .addOption("newest", "Newest wins — overwrite")
          .addOption("largest", "Largest wins — overwrite")
          .setValue(this.plugin.settings.conflictMode)
          .onChange(async (v) => {
            const mode = v as ConflictMode;
            const previous = this.plugin.settings.conflictMode;
            if (mode === previous) return;
            if (mode === "keep-both") {
              this.plugin.settings.conflictMode = mode;
              await this.plugin.saveSettings();
              return;
            }
            new ConfirmModal(this.app, {
              title: "Let conflicts overwrite?",
              body:
                "The losing version is discarded, not parked. If the remote side loses, " +
                "it stays recoverable from snapshot history — but if THIS device's edit " +
                "loses before it was ever synced, it is gone for good. This applies on " +
                "every device (the setting is shared).",
              onConfirm: async () => {
                this.plugin.settings.conflictMode = mode;
                await this.plugin.saveSettings();
              },
              onCancel: () => d.setValue(previous),
            }).open();
          });
      });

    new Setting(containerEl)
      .setName("Preview sync")
      .setDesc("Shows what a sync would change, without changing anything.")
      .addButton((b) => b.setButtonText("Preview").onClick(() => void this.plugin.previewSync()));

    new Setting(containerEl)
      .setName("Snapshot history")
      .setDesc("Browse past snapshots and restore a file or the whole vault.")
      .addButton((b) => b.setButtonText("Browse").onClick(() => void this.plugin.openHistory()));

    new Setting(containerEl)
      .setName("Unresolved conflicts")
      .setDesc(
        "Files two devices changed in ways that could not be merged. Both versions are on " +
          "disk; this shows the difference and lets you keep one, keep both, or combine them " +
          "into a single file."
      )
      .addButton((b) =>
        b
          .setButtonText(
            this.plugin.lastConflicts.length > 0
              ? `Review ${this.plugin.lastConflicts.length}`
              : "None"
          )
          .setDisabled(this.plugin.lastConflicts.length === 0)
          .onClick(() => this.plugin.openConflictReview(this.plugin.lastConflicts))
      );

    new Setting(containerEl)
      .setName("Pull remote over local")
      .setDesc(
        "Makes this vault match the current remote snapshot: its files are written and " +
          "anything else this device syncs is removed. Changes this device never published " +
          "are kept as .conflict-… copies. Use it when this device is the one that is wrong."
      )
      .addButton((b) =>
        b.setButtonText("Pull remote").setWarning().onClick(() => void this.plugin.forcePull())
      );

    new Setting(containerEl)
      .setName("Push local over remote")
      .setDesc(
        "Publishes this device's files as the new snapshot without merging what other " +
          "devices added since. Local files are not touched, and the snapshot being replaced " +
          "stays in history. Use it when every other copy is the one that is wrong."
      )
      .addButton((b) =>
        b.setButtonText("Push local").setWarning().onClick(() => void this.plugin.forcePush())
      );

    new Setting(containerEl)
      .setName("Sync log")
      .setDesc("Writes the recent sync passes to a note in this vault, for troubleshooting.")
      .addButton((b) => b.setButtonText("Export").onClick(() => void this.plugin.exportLog()));
  }

  #renderNotices(containerEl: HTMLElement): void {
    this.#heading(containerEl, "Notices");

    new Setting(containerEl)
      .setName("Notice when a sync finishes")
      .setDesc(
        Platform.isMobile
          ? "Every pass, background ones included. Recommended on mobile: there is no status " +
            "bar, so this is the only confirmation that a tap on the ribbon actually ran."
          : "Every pass, background ones included: how many files moved each way and the net " +
            "change in lines."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.notifyOnSync).onChange(async (v) => {
          this.plugin.settings.notifyOnSync = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Only notice syncs that changed something")
      .setDesc(
        "Skips the notice when a pass found nothing to do. A sync you start yourself always " +
          "answers, so a manual sync never looks like it failed to run."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.notifyOnlyChanged).onChange(async (v) => {
          this.plugin.settings.notifyOnlyChanged = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("List the changed files in the notice")
      .setDesc(
        "Names each file that moved, with its line change and the snapshot id, instead of " +
          "counts alone. Long lists are cut off. A line count is net — 5 lines replaced by 5 " +
          "others reads as 0 — and binary files have none."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.verboseSyncNotice).onChange(async (v) => {
          this.plugin.settings.verboseSyncNotice = v;
          await this.plugin.saveSettings();
        })
      );
  }

  #renderAdvanced(containerEl: HTMLElement): void {
    this.#heading(containerEl, "Advanced");
    containerEl.createEl("p", {
      text:
        "Defaults suit a typical vault. These are the knobs that were previously fixed in " +
        "code; each says what it costs, because every one of them trades something.",
    });

    this.#number(containerEl, {
      name: "Parallel lanes",
      desc:
        `How many files are read, encrypted, uploaded or downloaded at once (1–${MAX_LANES}). ` +
        "Higher finishes a large vault sooner but uses more memory and can overwhelm a " +
        "phone or a slow link. 1 restores the old one-at-a-time behaviour.",
      value: this.plugin.settings.lanes,
      range: `1–${MAX_LANES}`,
      accept: (n) => n >= 1 && n <= MAX_LANES,
      apply: (n) => {
        this.plugin.settings.lanes = clampLanes(n);
      },
    });

    this.#number(containerEl, {
      name: "Sync log length",
      desc:
        `Passes kept for troubleshooting (${LOG_ENTRIES_RANGE.min}–${LOG_ENTRIES_RANGE.max}). ` +
        "Each entry is small, but they all live in this plugin's data file.",
      value: this.plugin.settings.logEntries,
      range: `${LOG_ENTRIES_RANGE.min}–${LOG_ENTRIES_RANGE.max}`,
      accept: (n) => n >= LOG_ENTRIES_RANGE.min && n <= LOG_ENTRIES_RANGE.max,
      apply: (n) => {
        this.plugin.settings.logEntries = n;
      },
    });

    new Setting(containerEl)
      .setName("Report folder")
      .setDesc(
        "Where Export writes its note. Empty means the vault root. The folder is created " +
          "if it does not exist. Remember it is synced like any other note unless excluded."
      )
      .addText((t) => {
        let stored = this.plugin.settings.logNoteFolder;
        t.setPlaceholder("(vault root)");
        t.setValue(stored);
        this.#stage(t.inputEl, async () => {
          const next = t.inputEl.value.trim();
          if (next === stored) return;
          stored = next;
          t.setValue(next);
          this.plugin.settings.logNoteFolder = next;
          await this.plugin.saveSettings();
        });
      });

    this.#number(containerEl, {
      name: "Snapshots listed in history",
      desc: "How far back the history browser walks (1–200). Each one is a request.",
      value: this.plugin.settings.historyLimit,
      range: "1–200",
      accept: (n) => n >= 1 && n <= 200,
      apply: (n) => {
        this.plugin.settings.historyLimit = n;
      },
    });

    this.#number(containerEl, {
      name: "Automatic retries",
      desc:
        `Retries after a failed pass before it is reported and left alone (0–${MAX_RETRY_ATTEMPTS}), ` +
        "backing off 1s, 4s, 15s, 1m, 5m. A halted sync is never retried — it needs a person.",
      value: this.plugin.settings.retryAttempts,
      range: `0–${MAX_RETRY_ATTEMPTS}`,
      accept: (n) => n >= 0 && n <= MAX_RETRY_ATTEMPTS,
      apply: (n) => {
        this.plugin.settings.retryAttempts = n;
      },
    });

    new Setting(containerEl)
      .setName("Sync settings between devices")
      .setDesc(
        "Shares the vault-wide settings — excludes, safety threshold, debounce and sync " +
          "intervals, log/history/retry knobs, report folder, notices — through the server, " +
          "encrypted like your notes. The most recent change on any device wins. Always " +
          "per-device: credentials, device name, and parallel lanes."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncSettings).onChange(async (v) => {
          this.plugin.settings.syncSettings = v;
          await this.plugin.saveSettings();
        })
      );
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    // The controls these referred to are gone; a flush against them would read stale fields.
    this.#pending = [];

    // The cure, where the problem is. A wrong master key is the one failure a user cannot
    // fix from these fields — server URL and access token do not carry the key — so the
    // action that does fix it belongs above them, not further down the page.
    const mismatch = this.plugin.keyMismatch;
    const fresh = mismatch === null && isUnconfigured(this.plugin.settings);
    if (mismatch !== null) {
      new Setting(containerEl)
        .setName("This device is not set up for this vault")
        .setDesc(
          `${mismatch} Applying a setup link replaces this device's key, server URL and ` +
            "token in one step."
        )
        .addButton((b) =>
          b
            .setButtonText("Paste setup link")
            .setCta()
            .onClick(() => new PasteSetupModal(this.app, this.plugin).open())
        );
    } else if (fresh) {
      // Never both: the mismatch banner's cure is also "paste a setup link", and two primary
      // buttons doing the same thing on one page is a page that has stopped giving advice.
      this.#renderFirstRun(containerEl);
    }

    if (fresh) {
      // Nothing below this point can act without a server, and every one of those rows is
      // something to scroll past before reaching the two fields that can. They arrive the
      // moment the credentials do.
      this.#renderConnection(containerEl);
      this.#deviceNameRow(containerEl);
      this.#renderOverview(containerEl);
      return;
    }

    this.#renderOverview(containerEl);
    this.#renderConnection(containerEl);
    this.#renderThisDevice(containerEl);
    this.#renderEncryption(containerEl);
    this.#renderScope(containerEl);
    this.#renderSchedule(containerEl);
    this.#renderSafety(containerEl);
    this.#renderNotices(containerEl);
    this.#renderAdvanced(containerEl);
  }
}
