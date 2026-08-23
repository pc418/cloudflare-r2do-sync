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
  type TAbstractFile,
} from "obsidian";
import qrcode from "qrcode-generator";
import { SettingsStaleError, SyncApi, type HttpClient } from "./api";
import {
  VaultCrypto,
  deriveMasterKeyFromPassphrase,
  generateMasterKey,
  generateVaultSalt,
  parseMasterKey,
  parseVaultSalt,
  settingsAad,
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
  conflictSides,
  choiceBlockedReason,
  isResolvable,
  latestSide,
  missingSides,
  planResolutionOnDisk,
  pruneResolved,
  unresolvableReason,
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
  type ChangesUnknown,
  type ConflictInfo,
  type ContinuityDecision,
  type ContinuitySummary,
  type MassChangeDecision,
  type MassChangeSummary,
  type RestoreInspection,
  type RestoreOutcome,
  type SnapshotChange,
  type SnapshotChanges,
  type SnapshotInfo,
  type HistoryListing,
  type HistoryOptions,
  type SyncPreview,
  type SyncResult,
} from "./sync";
import {
  HISTORY_GRANULARITIES,
  isHistoryGranularity,
  type HistoryGranularity,
  type SnapshotGroup,
} from "./history-groups";
import type { FileEntry } from "./types";
import { decodeText, type ConflictMode } from "./merge";
import {
  LOG_ENTRIES_RANGE,
  MAX_LOG_ENTRIES,
  appendLog,
  entryFromError,
  entryFromResult,
  formatLogNote,
  relativeTime,
  describeHead,
  describePass,
  type SyncLogEntry,
} from "./log";
import {
  announcePass,
  announceStart,
  conflictReport,
  noticeAllowed,
  passNoticeLevel,
  passChangedSomething,
  resolveNoticeLevel,
  resolveNoticeStart,
  shortSnapshot,
  DEFAULT_NOTICE_LEVEL,
  DEFAULT_NOTICE_START,
  DEFAULT_ALWAYS_REPORT_MANUAL,
  LEGACY_NOTICE_KEYS,
  type NoticeCategory,
  type NoticeLevel,
} from "./notify";
import {
  MobileStatusBar,
  describeFailure,
  domMobileChrome,
} from "./mobile-status-bar";
import { countInScope, parseGlobs, DEFAULT_CONFIG_DIR } from "./paths";
import { DEFAULT_LANES, MAX_LANES, clampLanes, mapPool } from "./pool";
import { SyncScheduler, type ExclusiveHooks } from "./queue";
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
  /**
   * Minutes since the last pass before returning to the app starts a sync. `0` never does.
   *
   * Mobile only — that is where `visibilitychange` is registered, because a phone resumes far
   * more than it starts. Its own value rather than a share of `intervalMinutes`: the event
   * fires for screen unlocks and OS sheets too, so tying the two made a short sync interval
   * quietly multiply the number of passes a day of ordinary phone use produced.
   */
  resumeSyncMinutes: number;
  maxBlobMB: number;
  /** Share of the vault a pull may delete or overwrite before asking. 100 disables. */
  protectPercent: number;
  /** Unmergeable pairs: park the loser as a copy, or let newest/largest overwrite. */
  conflictMode: ConflictMode;
  /** Files handled at once per phase. Device-local: a phone wants fewer than a desktop. */
  lanes: number;
  /** Passes kept in the log. Larger means a longer trail and a larger `data.json`. */
  logEntries: number;
  /** Rows the history browser lists — one per sync, per day or per week. */
  historyLimit: number;
  /**
   * The unit those rows count in. Device-local, like `lanes` and the notice level: it is a
   * view preference, and "days on my phone, every sync on my desktop" is an ordinary thing to
   * want. `historyLimit` stays shared because it is a cost, not a view.
   */
  historyGranularity: HistoryGranularity;
  /** Automatic retries after a failed pass, before it is reported and left alone. */
  retryAttempts: number;
  /** Folder the exported report is written to. Empty means the vault root. */
  logNoteFolder: string;
  /**
   * Name put in front of every sync notice, and whether to use it at all.
   *
   * A field rather than a constant because the name is repeated on every pass forever, and on a
   * phone it is a meaningful share of a small screen. `showNoticePrefix` is separate from an
   * empty string so that turning it off does not destroy whatever was typed there.
   */
  noticePrefix: string;
  showNoticePrefix: boolean;
  /**
   * How much sync says on its own initiative — one ordered choice, not a toggle per topic.
   * `notify.ts` holds the ladder and the reasoning.
   */
  noticeLevel: NoticeLevel;
  /**
   * The "syncing…" opener, for a pass the user started. Outside the ladder on purpose: it
   * answers a click, which is the one thing the levels never govern.
   */
  notifyOnStart: boolean;
  /**
   * Whether a pass the user ran by hand reports itself whatever `noticeLevel` says — the
   * opener when it starts, the summary and any problem when it ends. Outside the ladder for
   * the same reason the opener is: the levels govern sync nobody asked for. `notify.ts` holds
   * the argument.
   */
  alwaysReportManualSync: boolean;
  /** List the changed files in the notice, not just how many files and lines moved. */
  verboseSyncNotice: boolean;
  /**
   * Put the snapshot the vault is on into the pass notice, on **every** pass rather than only
   * one that committed. Independent of `verboseSyncNotice`, which carries the id of a snapshot
   * a commit produced and so is silent on exactly the passes where the question is hardest to
   * answer from the screen.
   */
  showHeadInNotice: boolean;
  /**
   * Force Obsidian's hidden status bar visible on mobile. Off by default: it overrides
   * Obsidian's own layout, so it is opt-in and reversible.
   */
  mobileStatusBar: boolean;
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
  // 15 was the old hardcoded fallback for a vault with no interval set. As a real default it
  // also stops a short `intervalMinutes` from setting the resume rate, which is the change
  // someone syncing every 3 minutes will actually feel.
  resumeSyncMinutes: 15,
  maxBlobMB: 90,
  protectPercent: 50,
  conflictMode: "keep-both",
  lanes: DEFAULT_LANES,
  logEntries: MAX_LOG_ENTRIES,
  historyLimit: 40,
  // Days, because a vault committing a dozen times a day buries its own past under forty sync
  // rows — about three days of it. Every sync is one click away in the window.
  historyGranularity: "day",
  retryAttempts: 3,
  logNoteFolder: "",
  noticePrefix: "Cloudflare R2DO Sync",
  showNoticePrefix: true,
  noticeLevel: DEFAULT_NOTICE_LEVEL,
  notifyOnStart: DEFAULT_NOTICE_START,
  alwaysReportManualSync: DEFAULT_ALWAYS_REPORT_MANUAL,
  // Off: the compact summary already says how many files and lines moved each way, and a named
  // list is the one notice shape that can run to a dozen lines on a first sync. Knock-on worth
  // knowing: the snapshot id rides on the verbose form, so a default pass notice carries no id.
  // Every id that IS shown, anywhere, is the 7-character form; the exported log keeps all 26.
  verboseSyncNotice: false,
  // Off, like the verbose list and for the same reason: it is a line added to every pass
  // notice forever, and most passes are ones where nobody is asking which snapshot they are
  // on. One switch away for anyone who wants the vault's version in front of them.
  showHeadInNotice: false,
  mobileStatusBar: false,
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
 * The first-sync gate for a device that has nothing of its own yet — a fresh install that has
 * just been handed a setup link or a scanned code.
 *
 * The ordinary gate above asks the user to weigh a merge of two real vaults and to take a
 * backup first. Neither applies here: there is nothing on this device to lose, nothing of its
 * own to publish, and the pass is downgraded to pull-only so that stays true. Asking the
 * general question anyway would be describing a risk this case does not carry, which is how a
 * dialog teaches people to click through dialogs.
 */
export function emptyVaultConsentBody(mode: EncryptionMode): readonly string[] {
  return [
    "This vault has no notes of its own yet, so this first sync only downloads: the vault's " +
      "files are written here, and nothing on this device is published. Once it finishes, " +
      "this device syncs in both directions like any other.",
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

/**
 * This vault's configuration directory, which the user can rename ("Override config folder").
 * Every rule guarding this plugin's own `data.json` — access token and master key, in plaintext
 * — is keyed on it, so the literal `.obsidian` must never be assumed.
 *
 * `Vault.configDir` is documented and always present in Obsidian; the guard is for test doubles.
 * Falling back to the default cannot un-protect a default vault, because `alwaysSkip` skips the
 * default directory unconditionally whatever the active name is.
 */
function configDirOf(app: App): string {
  const dir = (app.vault as Partial<Vault> | undefined)?.configDir;
  return typeof dir === "string" && dir.trim() !== "" ? dir : DEFAULT_CONFIG_DIR;
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

/** Newline, spelled without a source escape so no tool can flatten it into the file. */
const NL = String.fromCharCode(10);

/** How often the status bar re-renders so "synced 3m ago" keeps counting up. */
const STATUS_REFRESH_MS = 30_000;

/**
 * How long the "syncing…" notice stays up at minimum. A pass on an up-to-date vault is over in
 * a few hundred milliseconds, and a notice that appears and vanishes inside that window reads
 * as no notice at all — the answer to "did my tap register" has to be legible.
 */
const MIN_START_NOTICE_MS = 1500;

/**
 * The command a hotkey is worth having. Named once because the hotkey manager keys bindings by
 * the *qualified* id (`<plugin id>:sync-now`), so a rename here would silently orphan a binding.
 */
/**
 * Why a conflict cannot be resolved while one of the three whole-vault rewrites runs.
 *
 * Each names the operation and what to do, because the alternative — queueing the choice
 * behind work that can take minutes — is the unresponsive button this serialisation exists to
 * remove. Each is shown to the user verbatim, so they are sentences, not codes.
 */
const ENCRYPTION_REWRITE_BLOCK =
  "Encryption is being changed, which rewrites every file on the remote. Wait for it to " +
  "finish, then resolve this conflict.";
const FORCE_PULL_BLOCK =
  "The remote is being pulled over this vault. Wait for it to finish, then resolve this " +
  "conflict — the pull may already have settled it.";
const RESTORE_ALL_BLOCK =
  "A snapshot is being restored over this vault. Wait for it to finish, then resolve this " +
  "conflict — the restore may already have settled it.";

/** What a pressed conflict-choice button says while it waits, and while it works. */
const QUEUED_LABEL = "Waiting for the current sync…";
const RESOLVING_LABEL = "Resolving…";

const SYNC_COMMAND = "sync-now";

/**
 * The one shared-settings failure with a specific cure: this device holds a key the vault
 * does not know. Distinguished from every other cause so the settings tab can offer the fix
 * (import the key from a working device) instead of only reporting the symptom.
 */
class WrongVaultKeyError extends Error {}

/**
 * The answer to the first-sync gate: whether to run at all, and whether this one pass is a
 * download. `pullOnly` is only ever true for the pass that immediately follows.
 */
interface FirstSyncConsent {
  proceed: boolean;
  pullOnly: boolean;
}

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
    headers: res.headers,
    text: async () => res.text,
    // Obsidian types `res.json` as `any`. `HttpResponse.json()` promises `unknown`, and
    // returning `any` through it silently re-opens every validated call site in `api.ts`.
    // The access stays inside the arrow so evaluation timing is unchanged.
    json: async (): Promise<unknown> => res.json,
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
  /**
   * Why a whole-vault rewrite currently forbids a conflict resolution, or null.
   *
   * The engine has its own one-operation-at-a-time mutex, but `restoreAll`, `forcePull` and
   * `migrateEncryption` write the vault *through* it while a conflict choice writes through
   * `ObsidianVault` directly — so that mutex cannot see the second writer, and the scheduler
   * lane cannot either, because none of the three is a sync pass. This holds a sentence rather
   * than a flag so the refusal names what is happening instead of leaking an internal error.
   */
  #vaultRewrite: string | null = null;
  #persistChain: Promise<void> = Promise.resolve();
  #stateServerUrl = "";
  #statusBar: HTMLElement | null = null;
  #ribbon: HTMLElement | null = null;
  /** The mobile status-bar override, built only on mobile and only while it is switched on. */
  #mobileStatusBar: MobileStatusBar | null = null;
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
    // A hand-edited or downgraded `data.json` can name a unit this build does not have. Left
    // alone it would fall through to weeks and silently show a history nobody asked for.
    if (!isHistoryGranularity(this.settings.historyGranularity)) {
      this.settings.historyGranularity = DEFAULT_SETTINGS.historyGranularity;
    }
    // The five per-category notice booleans became one level in 0.7.2. Resolved from the SAVED
    // object rather than from `this.settings`, because the spread above has already merged the
    // new defaults in and "absent" would no longer be distinguishable from "chosen". The old
    // keys are then deleted so a value nothing reads any more cannot be picked up by something
    // written later, and so `data.json` stops carrying them forward forever.
    const legacy = savedSettings as Record<string, unknown> | null;
    this.settings.noticeLevel = resolveNoticeLevel(legacy);
    this.settings.notifyOnStart = resolveNoticeStart(legacy);
    for (const key of LEGACY_NOTICE_KEYS) {
      delete (this.settings as unknown as Record<string, unknown>)[key];
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

    // Obsidian hides the status bar on mobile, so the ribbon is the always-present affordance a
    // phone has: it both starts a sync and carries the status in its tooltip. `mobileStatusBar`
    // can un-hide the bar itself, which is what makes silencing notices survivable there.
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
        void this.openConflictReview();
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

    const scheduleChanged = (paths: readonly string[], fullScan: boolean) => {
      // While a decision is pending, an automatic pass would re-run the whole plan and
      // silently re-park it. Manual syncs still work — that is how the user answers.
      if (this.#phase === "decision") return;
      this.#engine?.markDirty(paths, { fullScan });
      this.#scheduler?.notifyChange();
    };
    const onChange = (file: TAbstractFile) =>
      scheduleChanged([file.path], file instanceof TFolder);
    this.registerEvent(this.app.vault.on("create", onChange));
    this.registerEvent(this.app.vault.on("modify", onChange));
    this.registerEvent(this.app.vault.on("delete", onChange));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) =>
        scheduleChanged([oldPath, file.path], file instanceof TFolder)
      )
    );

    this.#restartAutoSyncTimer();

    if (this.settings.syncOnStartup) {
      this.app.workspace.onLayoutReady(() => void this.#autoSync());
    }

    // Deferred to layout-ready: the status bar and the mobile nav bar are both Obsidian's own
    // chrome, and neither is in the DOM while `onload` runs.
    if (Platform.isMobile && this.settings.mobileStatusBar) {
      this.app.workspace.onLayoutReady(() => {
        const failure = this.applyMobileStatusBar();
        // Deliberately NOT routed through the notice policy, and the only message here that is
        // not. Every other exemption is about a click deserving an answer; this one is about
        // the exemption's own premise: someone who silenced notices did it because the status
        // bar was carrying the state. If the bar could not be shown, that trade has silently
        // stopped holding, and a `console.error` nobody opens is how a device ends up with no
        // notices AND no status bar reporting a failing sync.
        if (failure !== null) new Notice(failure, 0);
      });
    }

    // A phone rarely cold-starts Obsidian — the OS suspends and RESUMES it, so
    // `onLayoutReady` never re-fires and the interval timer slept the whole time.
    // Becoming visible again is mobile's equivalent of startup, which is why `syncOnStartup`
    // still governs it and `resumeSyncMinutes` only narrows it further.
    //
    // The event is far noisier than "the user came back to the app": it also fires for screen
    // lock and unlock, the notification shade, split-screen, and any OS sheet. So the gap is
    // the whole guard, and it has its OWN setting rather than borrowing `intervalMinutes` —
    // sharing them meant a shorter sync interval silently made every screen unlock a sync,
    // which is not something the interval's name suggests.
    if (Platform.isMobile) {
      this.registerDomEvent(document, "visibilitychange", () => {
        if (document.visibilityState !== "visible" || !this.settings.syncOnStartup) return;
        const gapMinutes = this.settings.resumeSyncMinutes;
        if (gapMinutes <= 0) return; // 0 is off, and is the only way to reach zero gap
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
      // Never downgraded: this path already returned above if the first-sync gate was still
      // owed an answer, so an unattended pass is by definition not a device's first one.
      await this.#scheduler.syncNow({ fullScan: true });
    } catch {
      // reported through onError
    }
  }

  onunload(): void {
    if (this.#settingsPushTimer !== null) window.clearTimeout(this.#settingsPushTimer);
    if (this.#autoSyncTimer !== null) window.clearInterval(this.#autoSyncTimer);
    // Obsidian's own layout, put back as it was. A disabled plugin that leaves the status bar
    // forced open has broken the app rather than merely stopped working.
    this.#mobileStatusBar?.disable();
    this.#mobileStatusBar = null;
    this.#retireScheduler();
  }

  /**
   * Brings the mobile status bar into line with the setting, and says so when it cannot.
   *
   * Returns the failure rather than throwing: an Obsidian version that moved the status bar
   * must not stop the plugin from loading, but it must not pass silently either — the whole
   * point of the override is that someone is relying on that bar to see failures.
   */
  applyMobileStatusBar(): string | null {
    const wanted = Platform.isMobile && this.settings.mobileStatusBar;
    if (!wanted) {
      this.#mobileStatusBar?.disable();
      this.#mobileStatusBar = null;
      return null;
    }
    if (this.#mobileStatusBar !== null) return null;
    const { port, failure } = domMobileChrome(document);
    if (port === null) {
      const reason = describeFailure(failure ?? "no-status-bar");
      console.error(`R2DO Sync: ${reason}`);
      return reason;
    }
    this.#mobileStatusBar = new MobileStatusBar(port);
    this.#mobileStatusBar.enable();
    this.#renderStatus();
    return null;
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
    const rev: SettingsRev = { updatedAt: raw.updatedAt, device: raw.device, rev: raw.rev };
    if (this.#sharedSettings !== null && !isNewerRev(rev, this.#sharedSettings.rev)) {
      if (saltChanged) await this.#persist();
      return;
    }

    let plain: Record<string, unknown>;
    if (raw.v === 2 || raw.v === 3) {
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
      // v3 authenticates the revision and identity around the ciphertext; v2 does not, and
      // stays readable so an upgrade does not strand a vault's existing policy document.
      plain = await crypto.decryptSettingsJson<Record<string, unknown>>(
        raw.enc,
        raw.v === 3
          ? settingsAad({ v: 3, rev: raw.rev ?? 0, device: raw.device, keyId: raw.keyId, vaultSalt: raw.vaultSalt })
          : undefined
      );
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
      // A change made to this device by another one, which is what "changes" covers — the
      // same category as a pulled file, and for the same reason.
      this.#say("changes", `settings updated from "${rev.device}"`, 5000);
    } else {
      await this.#persist();
    }
  }

  async #pushSharedSettings(): Promise<void> {
    const api = this.#settingsApi();
    if (api === null) return;
    const fingerprint = sharedFingerprint(this.settings);
    if (this.#sharedSettings?.fingerprint === fingerprint) return;

    const shared = { ...extractSharedSettings(this.settings) } as Record<string, unknown>;
    const vaultSalt = this.settings.vaultSalt === "" ? {} : { vaultSalt: this.settings.vaultSalt };

    // The document says which revision it replaces, so the server refuses it outright if
    // another device wrote in the meantime. A rejection carries the revision that actually
    // won, so one retry settles it without re-running the whole pull-and-apply path.
    let nextRev = (this.#sharedSettings?.rev.rev ?? 0) + 1;
    for (let attempt = 0; ; attempt++) {
      const rev: SettingsRev = {
        updatedAt: Date.now(),
        device: this.settings.deviceName,
        rev: nextRev,
      };
      let doc: SettingsDoc;
      if (this.encryptionEnabled) {
        const crypto = await VaultCrypto.fromText(this.settings.masterKey);
        const envelope = {
          v: 3 as const,
          ...rev,
          ...vaultSalt,
          keyId: crypto.keyId,
        };
        doc = {
          ...envelope,
          enc: await crypto.encryptSettingsJson(
            shared,
            settingsAad({
              v: 3,
              rev: nextRev,
              device: envelope.device,
              keyId: envelope.keyId,
              vaultSalt: envelope.vaultSalt,
            })
          ),
        };
      } else {
        doc = { v: 1, ...rev, ...vaultSalt, plain: shared };
      }
      try {
        await api.putSettingsDoc(doc);
        this.#sharedSettings = { rev, fingerprint };
        await this.#persist();
        return;
      } catch (e) {
        if (attempt >= 1 || !(e instanceof SettingsStaleError)) throw e;
        nextRev = e.rev + 1;
      }
    }
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
        this.#sayUnwatched(
          "problems",
          `could not publish settings to other devices: ${message(e)}`,
          10_000
        );
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
      vault: new ObsidianVault(this.app, this.settings.lanes),
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
      // Not the literal `.obsidian`: a vault that renamed its config folder keeps this
      // plugin's `data.json` — access token and master key — somewhere else entirely.
      configDir: configDirOf(this.app),
      maxBlobBytes: Math.round(this.settings.maxBlobMB * 1024 * 1024),
      crypto,
      protectPercent: this.settings.protectPercent,
      conflictMode: this.settings.conflictMode,
      lanes: this.settings.lanes,
      decideMassChange: (s) =>
        generation === this.#generation
          ? this.#decideMassChange(s)
          : Promise.resolve<MassChangeDecision>("cancel"),
      decideContinuity: (s) =>
        generation === this.#generation
          ? this.#decideContinuity(s)
          : Promise.resolve<ContinuityDecision>("stop"),
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
   * Asked by the engine when it cannot trace the remote head back to the snapshot this device
   * last absorbed. Same rule as the mass-change guard, and for a stronger reason: a background
   * timer cannot judge whether the server's history is still the one it was syncing with.
   */
  async #decideContinuity(summary: ContinuitySummary): Promise<ContinuityDecision> {
    if (this.#interactive === 0) return "stop";
    return await new Promise<ContinuityDecision>((resolve) => {
      new ContinuityModal(this.app, summary, resolve).open();
    });
  }

  /**
   * The one-time "you are about to reconcile two real vaults" gate. Returns false when the
   * pass must not proceed: either the user declined, or nobody is watching to be asked.
   *
   * Persisted with `#persist`, never `saveSettings` — the flag is device-local, and
   * saveSettings retires the scheduler, which would deadlock the pass that called this.
   */
  async #confirmFirstSync({ mayPullOnly = false } = {}): Promise<FirstSyncConsent> {
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
      return { proceed: true, pullOnly: false };
    }
    if (this.#interactive === 0 || this.#firstSyncModalOpen) {
      new Notice(
        "R2DO Sync has not started yet: the first sync needs a confirmation. Open settings " +
          "or sync manually to answer it.",
        10_000
      );
      return { proceed: false, pullOnly: false };
    }
    // Only an ordinary pass can be downgraded, and only from two-way: a forced push asked to
    // publish, and a direction the operator set is not this gate's to reverse. A vault this
    // cannot inspect is one the pass could not have scanned either, so the error propagates
    // rather than being read as "not empty" — a wrong answer here publishes a blank note into
    // somebody else's vault.
    const pullOnly =
      mayPullOnly &&
      this.settings.syncMode === "two-way" &&
      this.#engine !== null &&
      (await this.#engine.isEffectivelyEmpty());

    this.#firstSyncModalOpen = true;
    const accepted = await new Promise<boolean>((resolve) => {
      new ConfirmModal(this.app, {
        title: pullOnly ? "Download the vault to this device?" : "Back up this vault before the first sync",
        body: pullOnly
          ? emptyVaultConsentBody(this.settings.encryptionMode)
          : firstSyncConsentBody(this.settings.encryptionMode),
        confirmText: pullOnly ? "Download the vault" : "I have a backup — sync",
        cancelText: "Not yet",
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false),
      }).open();
    });
    this.#firstSyncModalOpen = false;
    if (!accepted) {
      new Notice("R2DO Sync did not sync. It will ask again the next time you sync.", 8000);
      return { proceed: false, pullOnly: false };
    }
    this.settings.firstSyncAcknowledged = true;
    await this.#persist();
    return { proceed: true, pullOnly };
  }

  async syncNow(): Promise<void> {
    if (!this.#scheduler) {
      new Notice("R2DO Sync: set the server URL and access token in settings first");
      return;
    }
    this.#interactive++;
    // Raised only once the consent gate is past — a "syncing…" toast behind a modal asking
    // whether to sync at all describes something that has not been agreed to yet. Held open
    // for the whole pass (duration 0) and taken down in the `finally`, so it cannot outlive
    // the work even if the pass throws.
    let started: Notice | null = null;
    const startedAt = Date.now();
    try {
      const consent = await this.#confirmFirstSync({ mayPullOnly: true });
      if (!consent.proceed) return;
      this.#phase = "syncing";
      this.#renderStatus();
      if (
        announceStart({
          enabled: this.settings.notifyOnStart,
          interactive: true,
          alwaysManual: this.settings.alwaysReportManualSync,
        })
      ) {
        started = new Notice(this.#prefixed("syncing…"), 0);
      }
      try {
        await this.#syncSharedSettings();
      } catch (e) {
        // The file sync still runs — stale policy knobs beat not syncing notes at all.
        this.#say("problems", `shared settings check failed: ${message(e)}`, 10_000);
      }
      if (!this.#scheduler) return;
      // `pullOnly` is set only for the first pass of a device with nothing of its own to
      // publish, and `firstSyncAcknowledged` is true by now, so it can never repeat.
      await this.#scheduler.syncNow({ fullScan: true, pullOnly: consent.pullOnly });
    } catch {
      // reported through onError
    } finally {
      this.#dismissStartNotice(started, startedAt);
      this.#interactive--;
    }
  }

  /**
   * Takes the "syncing…" notice down, but never sooner than it can be read.
   *
   * A pass on an up-to-date vault finishes in a few hundred milliseconds, and a notice raised
   * and hidden inside that window is a flicker nobody sees — which is indistinguishable from
   * the toast not working at all. Holding it for a moment costs nothing on a slow pass, where
   * it has already been on screen far longer than this.
   */
  #dismissStartNotice(notice: Notice | null, raisedAt: number): void {
    if (notice === null) return;
    const shownFor = Date.now() - raisedAt;
    if (shownFor >= MIN_START_NOTICE_MS) {
      notice.hide();
      return;
    }
    window.setTimeout(() => notice.hide(), MIN_START_NOTICE_MS - shownFor);
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
    const engine = this.#engine;
    new HistoryModal(this.app, {
      listHistory: (limit, opts) => engine.listHistory(limit, opts),
      snapshotFiles: (id) => engine.snapshotFiles(id),
      inspectRestore: (id, path) => engine.inspectRestore(id, path),
      restoreFile: (id, path, opts) => engine.restoreFile(id, path, opts),
      restoreAll: (id) => this.#withVaultRewrite(RESTORE_ALL_BLOCK, () => engine.restoreAll(id)),
      syncsPath: (path) => engine.syncsPath(path),
      historyLimit: this.settings.historyLimit,
      granularity: this.settings.historyGranularity,
      // Remembered across openings, because the unit someone reads history in is a standing
      // preference. Kept device-local for the same reason the notice level is: "days on my
      // phone, every sync on my desktop" is ordinary, and a shared value cannot say it.
      // `#persist`, never `saveSettings`: this is device-local and saveSettings retires the
      // scheduler and schedules a shared-settings push, neither of which a dropdown warrants.
      rememberGranularity: (g) => {
        this.settings.historyGranularity = g;
        void this.#persist();
      },
      syncNow: () => this.syncNow(),
    }).open();
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
    // Ahead of the pull, not after it. This used to reach the gate only through the
    // `syncNow()` that publishes the result — by which point the remote had already been
    // written over this vault. The consent body is what states the self-hosting disclaimer
    // and asks for a backup, and it is worth nothing once the files it warns about are gone.
    this.#interactive++;
    let consented: boolean;
    try {
      consented = (await this.#confirmFirstSync()).proceed;
    } finally {
      this.#interactive--;
    }
    if (!consented) return;

    const summary = await this.#summarise(() => engine.forcePullSummary(), "pull the remote over this device");
    if (summary === null) return;

    new ConfirmModal(this.app, {
      title: "Pull the remote over this device?",
      body:
        `${summary.write} file(s) from snapshot ${shortSnapshot(summary.head)} will be written over this ` +
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
          // Held across the publish too: the whole sequence rewrites this vault, and a
          // conflict choice landing between the write and the commit would publish a state
          // neither the pull nor the user chose.
          await this.#withVaultRewrite(FORCE_PULL_BLOCK, async () => {
            // Pinned to the snapshot the confirmation described. A head published since was
            // never in the counts the operator agreed to, and this action overwrites files.
            const result = await engine.forcePull(summary.head);
            notice.hide();
            new Notice(
              `R2DO Sync: wrote ${result.written} file(s), removed ${result.removed}` +
                `${result.parked.length > 0 ? `, kept ${result.parked.length} local copy(s)` : ""}. ` +
                "Publishing the result…",
              8000
            );
            await this.syncNow();
          });
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
    // Publishing is publishing, however it is spelled. `syncNow` owns this gate, but this
    // path talks to the scheduler directly — so without asking here a device that has never
    // consented can overwrite the remote with its whole vault. Asked before the preview, so
    // the two dialogs do not stack. `forcePull` asks for itself, for the same reason.
    this.#interactive++;
    let consented: boolean;
    try {
      consented = (await this.#confirmFirstSync()).proceed;
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
        `${summary.head === null ? "an empty vault" : shortSnapshot(summary.head)}. ` +
          `${describePaths(summary.drop, "remote file")} ` +
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
        // Unconditional, like the one `forcePull` raises and for the same reason: this is the
        // direct answer to a typed confirmation, not a report about the vault, and the levels
        // never govern those. It is also the slowest thing on the page — a whole vault is
        // re-read and uploaded — so a window that closes onto nothing reads as an action that
        // did not take.
        const notice = new Notice("R2DO Sync: publishing this device over the remote…", 0);
        this.#interactive++;
        try {
          // A full audit, like the preview that produced `summary`. Publishing one direction
          // over the other from an event journal would push a vault the operator never saw.
          await scheduler.syncNow({ keepLocal: true, previewedHead: summary.head, fullScan: true });
        } catch (e) {
          await this.#reportUnlessReported(e);
        } finally {
          notice.hide();
          this.#interactive--;
        }
      },
    }).open();
  }

  /**
   * Publishes this device's vault as a NEW ROOT snapshot, discarding all earlier history.
   *
   * This is the only action that makes remote content stop existing. Every other publish —
   * forced or not — commits a child of the current head, so the old versions stay in the
   * chain and stay restorable. Rerooting orphans the whole chain instead, and the server's
   * garbage collection deletes it, along with every blob nothing live references any more.
   *
   * The deletion is therefore NOT immediate, and the confirmation says so: until GC next
   * runs, the old snapshots are unreachable but still stored.
   */
  async rebuildHistory(): Promise<void> {
    const engine = this.#engine;
    const scheduler = this.#scheduler;
    if (engine === null || scheduler === null) {
      new Notice("R2DO Sync: set the server URL and access token in settings first");
      return;
    }
    // Publishing is publishing: the same first-sync gate `forcePush` asks, for the same
    // reason, and asked before the preview so the two windows do not stack.
    this.#interactive++;
    let consented: boolean;
    try {
      consented = (await this.#confirmFirstSync()).proceed;
    } finally {
      this.#interactive--;
    }
    if (!consented) return;

    const summary = await this.#summarise(
      () => engine.rerootSummary(this.settings.historyLimit),
      "rebuild the remote history"
    );
    if (summary === null) return;
    if (summary.head === null) {
      new Notice("R2DO Sync: the remote has no snapshot yet, so there is no history to rebuild.");
      return;
    }

    const discarded = summary.discardedIsFloor
      ? `at least ${summary.discarded}`
      : `${summary.discarded}`;
    new ConfirmModal(this.app, {
      title: "Rebuild the remote history?",
      body: [
        `${summary.files} file(s) from this device become the only snapshot, replacing ` +
          `${shortSnapshot(summary.head)}. ${summary.carried} path(s) this device does not sync are carried ` +
          "unchanged. Local files are not touched.",
        `${discarded} earlier snapshot(s) are discarded. Every version of every file they ` +
          "hold — including anything you are trying to purge — stops being restorable, on " +
          "this device and on every other one. There is no undo, and no other action on this " +
          "page destroys history.",
        "The server frees the storage on a later daily collection, not immediately — and it " +
          "holds back anything uploaded in the past 24 hours, so content synced today can " +
          "take an extra day to go. Until then the old snapshots are unreachable but stored.",
      ],
      phrase: "REBUILD HISTORY",
      onConfirm: async () => {
        this.#phase = "syncing";
        this.#renderStatus();
        // Same rule as the two forced directions: the answer to a typed confirmation is never
        // governed by the notice level. This one has the strongest claim of the three — it is
        // the only action on the page that destroys history, and it runs long.
        const notice = new Notice("R2DO Sync: rebuilding the remote's history…", 0);
        this.#interactive++;
        try {
          // Pinned to the head the confirmation just described. A snapshot published
          // since then has never been reviewed, and this is the one action that would
          // delete it rather than merge it.
          await scheduler.syncNow({ reroot: { previewedHead: summary.head }, fullScan: true });
        } catch (e) {
          await this.#reportUnlessReported(e);
        } finally {
          notice.hide();
          this.#interactive--;
        }
      },
    }).open();
  }

  /**
   * Reports a failed forced action that nothing else has reported.
   *
   * An engine failure travels through the scheduler's `onError` and has already produced a
   * notice by the time it is rethrown here, so swallowing it was *almost* right. But a
   * scheduler retired while the confirmation window stood open — any settings save does that —
   * rejects before the engine ever runs, and that rejection reaches no handler at all: the
   * action then failed silently and left the status bar reading "syncing" for good.
   *
   * `#report`/`#reportError` both move the phase off "syncing", so a phase still stuck there
   * is exactly the case nothing handled.
   */
  async #reportUnlessReported(e: unknown): Promise<void> {
    if (this.#phase !== "syncing") return;
    await this.#reportError(e instanceof Error ? e : new Error(String(e)));
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
        `R2DO Sync configured as "${payload.name}"${payload.mode === "encrypted" ? " (encrypted)" : " (plaintext)"}. Remote head: ${head === null ? "(empty vault)" : shortSnapshot(head)}`,
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
    // Held across the rebuild, not just the migration: the block is released by the `finally`
    // only once a usable scheduler is installed again.
    await this.#withVaultRewrite(ENCRYPTION_REWRITE_BLOCK, async () => {
      await this.#persist();
      // Stopped, deliberately NOT retired. `#retireScheduler()` bumps `#generation`, and the
      // engine's `StateStore` refuses every load and save from an older generation — so
      // retiring here kills the migration this method is about to run, with "sync
      // configuration changed". The stopped scheduler therefore stays installed for the
      // duration, and `#vaultRewrite` above is what keeps a conflict choice from meeting it
      // and being told "sync scheduler stopped".
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
    });
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
        : result.status === "needs-decision" || result.status === "needs-continuity"
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
   *
   * Both of those are governed by the `conflicts` category, the modal included. Auto-opening a
   * window is a *larger* interruption than the notice beside it, so a device that asked not to
   * be told about conflicts must not get one — a category that silenced the quiet half and
   * kept the loud half would be worse than no setting.
   *
   * The record is not governed. `#lastConflicts` is assigned before any of it, so the conflicts
   * are still on disk, still counted on the settings page, and still listed by "Review and
   * resolve conflicts". Silencing loses the prompt, never the evidence.
   */
  #reportConflicts(result: SyncResult): void {
    const details = result.conflictDetails;
    if (details.length === 0) return;
    // Kept before anything is decided: the record is not what the setting governs.
    this.#lastConflicts = details;
    const how = conflictReport({
      level: this.noticeLevel,
      interactive: this.#interactive > 0,
    });
    if (how === "none") return;
    if (how === "modal") {
      void this.openConflictReview();
      return;
    }
    const names = details.map((c) => c.path);
    const shown = names.slice(0, 3).join(", ");
    const more = names.length > 3 ? ` +${names.length - 3} more` : "";
    // "Pick a side" is only true when there are two files here to pick between. Push-only
    // keeps the other version in the snapshot, and an overwrite mode discarded it outright;
    // sending the user to a window that can only explain itself should say so first.
    const advice = details.some((c) => isResolvable(c))
      ? 'Run "Review and resolve conflicts" to see the differences and pick a side.'
      : 'Run "Review and resolve conflicts" for what happened to each one.';
    this.#say(
      "conflicts",
      `${names.length} conflict${names.length === 1 ? "" : "s"} — ${shown}${more}. ${advice}`,
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

  /**
   * Opens the conflict view on the outstanding batch, wired so a choice actually resolves the
   * file.
   *
   * The batch is checked against the disk first. It survives restarts, and every way a pair
   * can leave — resolved on another device and the deletion pulled here, the note renamed, a
   * copy deleted by hand — is invisible to a list that is only ever replaced wholesale. The
   * window used to offer buttons for those, and every click failed with "it was already
   * resolved", which is true and useless.
   */
  async openConflictReview(): Promise<void> {
    const batch = this.#lastConflicts;
    // Every caller starts this and walks away, so a rejection here would surface as nothing
    // at all: no window, no notice, an unhandled promise. Failing to *check* the disk is not
    // a reason to withhold the list — resolution re-checks each pair at click time anyway.
    let outstanding = batch;
    // Kept for the window: `pruneResolved` only drops pairs whose *copy* has gone, and in the
    // ordinary layout the other side is the note's own path. Without this the window offers
    // buttons for a note that was deleted after the conflict was recorded, every one of them
    // fails with "is gone", and the entry can never clear.
    let present: ReadonlySet<string> = new Set<string>();
    try {
      present = await this.#presentPaths(batch);
      outstanding = pruneResolved(batch, present);
    } catch (e) {
      new Notice(
        `R2DO Sync could not check which conflicts are still on disk: ${message(e)}. ` +
          "Showing the recorded list; some entries may already be resolved.",
        10_000
      );
    }
    const cleared = batch.length - outstanding.length;
    if (cleared > 0) {
      this.#lastConflicts = outstanding;
      await this.#persist();
      new Notice(
        `R2DO Sync: ${cleared} conflict${cleared === 1 ? " was" : "s were"} already resolved ` +
          "elsewhere, so they are no longer listed.",
        8000
      );
    }
    new ConflictReportModal(
      this.app,
      outstanding,
      {
        readText: (path) => this.#readTextIfPresent(path),
        resolve: (info, choice, hooks) => this.resolveConflict(info, choice, hooks),
      },
      present
    ).open();
  }

  /** Which of these paths hold a file right now — one stat each, never a vault walk. */
  async #presentPaths(conflicts: readonly ConflictInfo[]): Promise<Set<string>> {
    const vault = new ObsidianVault(this.app);
    const wanted = new Set<string>();
    for (const info of conflicts) {
      wanted.add(info.path);
      if (info.copy !== null) wanted.add(info.copy);
    }
    const present = new Set<string>();
    await mapPool([...wanted], this.settings.lanes, async (path) => {
      if (await vault.exists(path)) present.add(path);
    });
    return present;
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
   * The disk is re-read here rather than trusting what the modal was drawn from: a pass may
   * have parked this copy minutes ago and the user may have edited or deleted either side since.
   * Overwriting an edit made in that window is precisely the loss this feature exists to
   * prevent, so a missing side stops with a message instead.
   *
   * Keeping a side moves bytes; only "combine" writes text. That is what makes the choice work
   * on an attachment, which is the very kind of file that cannot be merged in the first place.
   *
   * Nothing is committed. The next ordinary pass publishes the outcome, which keeps this off the
   * commit path entirely.
   */
  async resolveConflict(
    info: ConflictInfo,
    choice: ConflictChoice,
    hooks?: ExclusiveHooks
  ): Promise<void> {
    // Checked before anything is queued: these rewrites run for as long as they run, and a
    // button that waits minutes is the dead-button complaint again rather than a fix for it.
    if (this.#vaultRewrite !== null) throw new Error(this.#vaultRewrite);
    const scheduler = this.#scheduler;
    if (scheduler !== null) {
      await scheduler.runExclusive(() => this.#resolveConflictOnDisk(info, choice), hooks);
      return;
    }
    // A rebuild hides its scheduler immediately, then drains the old one before installing
    // the replacement. Waiting here avoids racing the old pass; re-checking afterwards lets
    // the choice join the replacement's lane if configuration is still usable. With no
    // scheduler after the drain, no pass can overlap a direct local resolution.
    //
    // Deliberately no `onQueued`: on a device that cannot sync at all — no server URL, no
    // key — this is the ordinary path and the drain is already resolved, so announcing a wait
    // for "the current sync" would describe a pass that does not exist.
    await this.#schedulerDrain;
    if (this.#vaultRewrite !== null) throw new Error(this.#vaultRewrite);
    const replacement = this.#scheduler;
    if (replacement !== null) {
      await replacement.runExclusive(() => this.#resolveConflictOnDisk(info, choice), hooks);
      return;
    }
    hooks?.onStart?.();
    await this.#resolveConflictOnDisk(info, choice);
  }

  /**
   * Holds the whole-vault-rewrite block for one operation.
   *
   * Restores the previous reason rather than clearing, so a rewrite that runs a sync inside
   * itself — `forcePull` publishes its result — does not unblock halfway through.
   */
  async #withVaultRewrite<T>(reason: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#vaultRewrite;
    this.#vaultRewrite = reason;
    try {
      return await run();
    } finally {
      this.#vaultRewrite = previous;
    }
  }

  async #resolveConflictOnDisk(info: ConflictInfo, choice: ConflictChoice): Promise<void> {
    const vault = new ObsidianVault(this.app);
    const present = await this.#presentPaths([info]);
    const sides = conflictSides(info);
    // Only "combine" reads content, and reading a file to decide it is not text is exactly
    // the check that has to happen before it can refuse.
    const text = async (path: string): Promise<string | null> =>
      choice === "combine" && present.has(path) ? await this.#readTextIfPresent(path) : null;
    const ops = planResolutionOnDisk(info, choice, {
      present,
      mine: await text(sides.mine),
      theirs: await text(sides.theirs),
    });

    const encoder = new TextEncoder();
    for (const move of ops.promotes) await vault.write(move.to, await vault.read(move.from));
    for (const write of ops.writes) await vault.write(write.path, encoder.encode(write.text));
    for (const path of ops.removes) await vault.remove(path);

    // Decided is decided, "keep both" included: what the list shows is what is still open.
    this.#lastConflicts = this.#lastConflicts.filter((c) => c !== info && c.copy !== info.copy);
    await this.#persist();
  }

  async #reportError(e: Error): Promise<void> {
    this.#log = appendLog(this.#log, entryFromError(e, Date.now()), this.settings.logEntries);
    this.#lastFailureAt = Date.now();
    this.#progress = null;
    this.#phase = "idle";
    this.#renderStatus();
    // Governed like every other status notice. The failure itself is not suppressed — it is in
    // the log, `lastFailureAt` has moved, and the status bar reads the failure — so what a
    // silenced device loses is the interruption, not the evidence.
    this.#say("problems", `error: ${e.message}`, 10_000);
    await this.#persist();
  }

  /**
   * How much this device says. Read fresh at every call site rather than cached, because
   * settings can be rewritten mid-pass by an applied shared-settings document.
   */
  get noticeLevel(): NoticeLevel {
    return this.settings.noticeLevel;
  }

  /**
   * The configured name, or "" when it is switched off or blank.
   *
   * Trimmed here rather than on save, so a stray space cannot produce a notice that begins with
   * one — and so the stored value stays exactly what the user typed.
   */
  get noticeName(): string {
    return this.settings.showNoticePrefix ? this.settings.noticePrefix.trim() : "";
  }

  /**
   * A notice's text with the configured name in front of it.
   *
   * The name is a prefix rather than part of each message, so that turning it off leaves a
   * sentence rather than a hole: every message below is written to read correctly both as
   * "R2DO Sync halted: …" and as "halted: …".
   */
  #prefixed(text: string): string {
    const name = this.noticeName;
    // A leading newline is the caller asking for the message to sit on its own line BELOW the
    // name. With no name there is nothing to sit below, so it would render as a blank first
    // line — the label's absence should cost the row it occupied, not leave a hole where it was.
    if (name === "") return text.startsWith(NL) ? text.slice(NL.length) : text;
    return text.startsWith(NL) ? `${name}${text}` : `${name} ${text}`;
  }

  /**
   * Raises a notice only if its category is enabled on this device.
   *
   * Every self-initiated sync notice goes through here or through `#sayUnwatched`, which is
   * what makes the `silent` level mean silence rather than "quieter in the places someone
   * remembered". A notice that answers a click calls `new Notice` directly and is deliberately
   * not routed here.
   *
   * **This one is for a notice raised from inside a pass**, which every caller of it is: the
   * summary, what the pass pulled or skipped, a conflict, a halt, an unanswered question, a
   * failure. Those are what someone who just tapped "Sync now" is waiting for, so they read
   * `#levelNow()` and are promoted while the user is watching.
   *
   * Anything raised by a timer or a callback that is **not** part of a pass must use
   * `#sayUnwatched` instead. `#interactive` describes the moment, not the notice, so a
   * background failure that merely overlaps a hand-started action would otherwise be promoted
   * by it — putting an unrelated message on the screen of a device that asked for silence.
   */
  #say(category: NoticeCategory, text: string, durationMs?: number): void {
    if (!noticeAllowed(this.#levelNow(), category)) return;
    new Notice(this.#prefixed(text), durationMs);
  }

  /**
   * The same gate at the **stored** level, for the one notice nobody is waiting on.
   *
   * The debounced shared-settings push is a timer with no pass behind it: it is scheduled by
   * whichever save happened to move a shared value, fires two seconds later, and its failure
   * is not an answer to anything. Reading `#levelNow()` there would mean a silenced device
   * announcing a settings-publish failure purely because the timer landed inside an unrelated
   * manual sync or a force-action confirmation — the exact "sync nobody asked for" case the
   * ladder exists to govern.
   *
   * One caller today, and it should stay that way: prefer `#say` unless the notice genuinely
   * has no pass behind it.
   */
  #sayUnwatched(category: NoticeCategory, text: string, durationMs?: number): void {
    if (!noticeAllowed(this.noticeLevel, category)) return;
    new Notice(this.#prefixed(text), durationMs);
  }

  /**
   * The level to judge a notice by **right now**, which is not always the stored one.
   *
   * While the user is inside an action they started — "Sync now", the ribbon, a hotkey, a force
   * push or pull, a reroot — `alwaysReportManualSync` lifts the pass to `all`, so the summary
   * and any problem it hit reach the screen whatever the ladder is set to. The instant the
   * action ends, `#interactive` falls back to zero and the timer is governed exactly as before.
   *
   * Read fresh at every call rather than captured at the start of a pass, for the same reason
   * `noticeLevel` is: an applied shared-settings document can rewrite the level mid-pass.
   *
   * Deliberately not consulted by `#reportConflicts`, which reads the stored level: this raises
   * messages and must never be the thing that opens a window.
   */
  #levelNow(): NoticeLevel {
    return passNoticeLevel({
      level: this.noticeLevel,
      interactive: this.#interactive > 0,
      alwaysManual: this.settings.alwaysReportManualSync,
    });
  }

  #notify(result: SyncResult): void {
    const changed = passChangedSomething(result);
    // A pass that stopped never reaches the summary — "up to date" above a notice saying
    // nothing was done is a false statement — so the snapshot line has to ride on the notice
    // that explains the stop instead. Deciding it once, here, is what keeps the id to exactly
    // one notice per pass: a halted pass that also pulled files would otherwise print it on
    // the `changes` line below AND on the halt.
    const stopped =
      result.status === "halted" ||
      result.status === "needs-decision" ||
      result.status === "needs-continuity";
    const headOn = this.settings.showHeadInNotice;
    // The stop notices are sticky (duration 0) and the lines above them are not, so on a
    // stopped pass the id goes where it will still be on screen when someone reads it.
    const withHead = (text: string): string =>
      headOn ? `${text}${NL}${describeHead(result)}` : text;
    if (announcePass({ level: this.#levelNow(), result })) {
      const verbose = this.settings.verboseSyncNotice;
      const head = headOn && !stopped;
      // A named list takes longer to read than "up to date", and a pass that moved nothing
      // should not linger on screen. An id is worth a little longer than that, though: it is
      // there to be read off, and often copied against the history window.
      const duration = !changed ? (head ? 6_000 : 4_000) : verbose ? 12_000 : 8_000;
      const detail = describePass(result, { verbose, head });
      new Notice(this.#prefixed(`${NL}${detail}`), duration);
    } else if (result.pulled > 0) {
      // Files changed under the user without them asking. This used to be the floor no setting
      // could remove; it is now its own category, because a device asked to be silent has a
      // status bar to say so and a popup it did not want is still a popup.
      this.#say(
        "changes",
        stopped
          ? `changed ${result.pulled} local file(s)`
          : withHead(`changed ${result.pulled} local file(s)`)
      );
    }
    if (result.skipped.length > 0) {
      const detail = result.skipped
        .slice(0, 5)
        .map((s) => `${s.path} (${s.reason})`)
        .join("\n");
      this.#say("problems", `skipped ${result.skipped.length} file(s):\n${detail}`, 10_000);
    }
    if (result.conflicts.length > 0) {
      // Never a silent resolution: both versions are on disk and the user has to choose. The
      // conflict list also survives in `#lastConflicts`, so silencing this loses the prompt
      // and not the record — "Review and resolve conflicts" still finds them.
      this.#say(
        "conflicts",
        `could not merge ${result.conflicts.length} file(s). The other device's ` +
          `version is saved beside yours:\n${result.conflicts.slice(0, 5).join("\n")}`,
        0
      );
    }
    if (result.status === "halted") {
      this.#say("problems", withHead(`halted: ${result.reason}`), 0);
      return;
    }
    if (result.status === "needs-decision") {
      const { deletes, overwrites, percent } = result.summary;
      this.#say(
        "problems",
        withHead(
          `paused: the remote would delete ${deletes.length} and overwrite ` +
            `${overwrites.length} file(s) here — ${percent}% of this vault. Run "Sync now" to ` +
            `review and choose what happens.`
        ),
        0
      );
    }
    if (result.status === "needs-continuity") {
      // "Nothing was published" and not "nothing was changed": an earlier turn of the same
      // pass may have applied a snapshot whose history it did confirm, and `result.pulled`
      // has its own notice above saying so.
      this.#say(
        "problems",
        withHead(
          "paused: it could not trace the remote's current snapshot back to the one " +
            `this device last synced (${result.continuity.reason}). Nothing was published. Run ` +
            '"Sync now" to see what was checked and decide.'
        ),
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
  // The class is what makes it legible: full width, monospace, and breaking mid-token. A
  // setup link is ~400 unbroken base64 characters, and the default box shows about a dozen
  // of them — which is how "you can see the link now" shipped as a mystery empty box.
  const field = parent.createEl("textarea", { cls: "r2do-secret" });
  field.value = value;
  field.readOnly = true;
  field.rows = 4;
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

/**
 * The user-facing half of head-descent verification: the remote is offering a snapshot whose
 * ancestry this device cannot trace back to what it last synced.
 *
 * Deliberately not phrased as an accusation. Every reason here has an ordinary cause — a
 * rebuilt history, a device away past the retention window — and the same shape as a served
 * rollback, and there is nothing on this device that can tell them apart. So it states what
 * was checked, what that could mean, and lets someone who knows which devices exist decide.
 */
export function continuityBody(summary: ContinuitySummary): string[] {
  const what: Record<ContinuitySummary["reason"], string> = {
    replaced:
      "The remote's history now starts from a snapshot that has no parent, and this device's " +
      "own snapshot is not anywhere in it. That is exactly what \"Rebuild remote history\" on " +
      "another device does — and also what a remote whose history was replaced looks like.",
    truncated:
      "The remote's history stops before this device's own snapshot. That is ordinary once a " +
      "device has been away longer than the server keeps history — and also what a remote " +
      "whose history was replaced looks like.",
    limit:
      `The check walked ${summary.walked} snapshots back without finding this device's own ` +
      "and stopped there rather than downloading the rest of the chain.",
    unauthenticated:
      "The trail runs back into a snapshot this device cannot authenticate — an older " +
      "encryption version, or one written under a key this device no longer holds. From " +
      "there on, the link from each snapshot to the one before it is only the server's " +
      "word, so the check stopped rather than finish on it. Ordinary on a vault whose " +
      "history reaches back past an encryption change.",
  };
  return [
    what[summary.reason],
    `Remote head: ${shortSnapshot(summary.head)}. Last synced from this device: ${shortSnapshot(summary.lastHead)}.`,
    "Continuing merges the remote in the ordinary way: nothing is deleted here without the " +
      "usual large-change question, and anything that cannot be merged keeps both versions.",
    // Never "stopping changes nothing": a pass that applied a verified snapshot and then lost
    // the head race has already written files, and saying otherwise would be a false promise
    // about the very thing the user is being asked to judge.
    summary.alreadyApplied > 0
      ? `Stopping publishes nothing and leaves the remote untouched. It does not undo the ` +
        `${summary.alreadyApplied} file(s) this pass already applied from an earlier snapshot ` +
        `whose history it did confirm. The question comes back on the next sync.`
      : "Stopping leaves both sides exactly as they are, and the question comes back on the " +
        "next sync.",
    "If you did not expect this, check Browse snapshot history before continuing.",
  ];
}

class ContinuityModal extends Modal {
  #answered = false;

  constructor(
    app: App,
    private readonly summary: ContinuitySummary,
    private readonly resolve: (d: ContinuityDecision) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Cannot confirm the remote's history" });
    for (const text of continuityBody(this.summary)) contentEl.createEl("p", { text });

    new Setting(contentEl)
      .addButton((b) => {
        b.setButtonText("Stop for now")
          .setCta()
          .onClick(() => this.#answer("stop"));
      })
      .addButton((b) => {
        b.setButtonText("Merge anyway")
          .setWarning()
          .onClick(() => this.#answer("continue"));
      });
  }

  #answer(decision: ContinuityDecision): void {
    this.#answered = true;
    this.resolve(decision);
    this.close();
  }

  onClose(): void {
    // Dismissal is not an answer, and here the safe non-answer is to touch nothing.
    if (!this.#answered) this.resolve("stop");
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
      text: `Remote head: ${preview.head === null ? "(empty vault)" : shortSnapshot(preview.head)}. Nothing has been changed.`,
    });

    if (preview.halted) {
      contentEl.createEl("p", { text: `Sync would halt: ${preview.halted}` });
      return;
    }
    if (preview.continuity) {
      // Above the plan, not beside it: everything below assumes this remote is the same
      // history this device has been syncing with, and that is the assumption in question.
      contentEl.createEl("p", {
        text:
          "This pass would stop to ask first: the remote's current snapshot could not be " +
          `traced back to the one this device last synced (${preview.continuity.reason}).`,
      });
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
/**
 * What the history windows need to do their job, narrowed to an interface so a test can drive
 * them without a whole plugin behind them. `SyncEngine` supplies all but the last two.
 */
export interface HistoryDeps {
  listHistory(limit: number, opts?: HistoryOptions): Promise<HistoryListing>;
  snapshotFiles(id: string): Promise<Record<string, FileEntry>>;
  inspectRestore(id: string, path: string): Promise<RestoreInspection>;
  restoreFile(
    id: string,
    path: string,
    opts?: { destination?: string; overwrite?: boolean }
  ): Promise<RestoreOutcome>;
  restoreAll(id: string): Promise<{ written: number; removed: number }>;
  /** Whether this device syncs a path, so a restore onto one it does not can say so. */
  syncsPath(path: string): boolean;
  /** How many rows to list; each one is a manifest fetch. */
  historyLimit: number;
  /** The unit the window opens in. */
  granularity: HistoryGranularity;
  /** Remembers a granularity the user picked, so the window reopens the way they left it. */
  rememberGranularity(granularity: HistoryGranularity): void;
  /** Publishes a restored vault, so the snapshot the user chose becomes the new head. */
  syncNow(): Promise<void>;
}

/** How many changed paths a history row previews before deferring to the snapshot window. */
const CHANGE_PREVIEW = 5;

/**
 * Local midnight of the day after the one this instant falls in.
 *
 * Built from calendar components rather than by adding 86,400,000 ms, because on a
 * daylight-saving transition a day is not that long: spring forward and the arithmetic lands an
 * hour into the *next* date, autumn back and it stops an hour short of the one the user named.
 * A history range is explicitly a device-local calendar range, so its end has to be one too.
 */
function nextLocalDay(at: number): number {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

const UNKNOWN_CHANGES: Record<ChangesUnknown, string> = {
  unreadable: "changes unknown — this snapshot cannot be read with this device's key",
  "parent-unreadable": "changes unknown — the previous snapshot cannot be read with this device's key",
  "parent-missing": "changes unknown — the previous snapshot is no longer retained",
};

/** `+42 -7 lines`, or a byte figure for history committed before counts were recorded. */
function fmtLineChange(c: SnapshotChanges): string | null {
  if (c.files.length > c.linesUnknown) {
    const counted = `+${c.linesAdded} -${c.linesRemoved} lines`;
    return c.linesUnknown === 0 ? counted : `${counted} (${c.linesUnknown} not counted)`;
  }
  // Every changed file was binary, or predates `lines`. Bytes are the honest fallback.
  if (c.bytes === 0) return null;
  return `${fmtBytes(Math.abs(c.bytes))} ${c.bytes < 0 ? "smaller" : "larger"}`;
}

/**
 * How wide an interval a diff covers, when it is wider than one snapshot.
 *
 * Said out loud because the row otherwise reads as "this is what that sync did". Once the
 * snapshots in between have been collected, the comparison is still exact but the steps it
 * passed through are gone — and a reader deciding what to restore needs to know that the
 * intermediate versions no longer exist rather than that nothing happened in them.
 */
function fmtSpan(changes: SnapshotChanges): string | null {
  const spans = changes.spans ?? 1;
  return spans > 1 ? `spans ${spans} syncs` : null;
}

/** One snapshot's change summary as a single line. Never guesses: what it cannot state, it omits. */
export function describeChanges(changes: SnapshotChanges | { unknown: ChangesUnknown }): string {
  if ("unknown" in changes) return UNKNOWN_CHANGES[changes.unknown];
  const span = fmtSpan(changes);
  if (changes.files.length === 0) {
    return span === null ? "no file changes" : `no file changes · ${span}`;
  }
  const counts: string[] = [];
  if (changes.added > 0) counts.push(`${changes.added} added`);
  if (changes.modified > 0) counts.push(`${changes.modified} changed`);
  if (changes.removed > 0) counts.push(`${changes.removed} removed`);
  const parts = [changes.initial ? `${counts.join(", ")} (first snapshot)` : counts.join(", ")];
  const lines = fmtLineChange(changes);
  if (lines !== null) parts.push(lines);
  if (span !== null) parts.push(span);
  return parts.join(" · ");
}

/** One changed file as a line: what happened to it, and by how much. */
export function describeChangedFile(c: SnapshotChange): string {
  const verb = c.kind === "added" ? "added" : c.kind === "removed" ? "removed" : "changed";
  const amount =
    c.lines === null
      ? fmtBytes(Math.abs(c.bytes))
      : `${c.lines >= 0 ? "+" : ""}${c.lines} line${Math.abs(c.lines) === 1 ? "" : "s"}`;
  return `${verb} · ${c.path} · ${amount}`;
}

/** What a grouped row is called: the calendar unit it stands for, in the reader's own locale. */
export function describeGroup(group: SnapshotGroup): string {
  const start = new Date(group.start);
  if (group.granularity === "week") {
    return `Week of ${start.toLocaleDateString(undefined, {
      day: "numeric",
      month: "long",
      year: "numeric",
    })}`;
  }
  return start.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** The devices behind a row, however many committed into it. */
function describeDevices(snap: SnapshotInfo): string {
  const devices = snap.group?.devices ?? [];
  if (devices.length === 0) return snap.device;
  return devices.join(", ");
}

/** A `yyyy-mm-dd` field's value as a local instant, or null when it is empty or nonsense. */
export function parseDateField(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (m === null) return null;
  // Built from local components on purpose: the user typed a day in their own calendar, and
  // `new Date("2026-08-20")` would parse it as UTC midnight and shift it for half the world.
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(at.getTime()) ? null : at.getTime();
}

const GRANULARITY_LABELS: Record<HistoryGranularity, string> = {
  sync: "Every sync",
  day: "Day",
  week: "Week",
};

export class HistoryModal extends Modal {
  #granularity: HistoryGranularity;
  #from = "";
  #to = "";
  /** Redrawn on every control change; the controls above it are built once and left alone. */
  #listEl: HTMLElement | null = null;
  /** Guards against a slow listing landing after a newer one the user asked for. */
  #generation = 0;

  constructor(
    app: App,
    private readonly deps: HistoryDeps
  ) {
    super(app);
    this.#granularity = deps.granularity;
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Snapshot history" });
    this.#renderControls(contentEl);
    this.#listEl = contentEl.createDiv();
    await this.#renderList();
  }

  #renderControls(contentEl: HTMLElement): void {
    // A block body, not an expression one: Obsidian's fluent setters return the component,
    // which is structurally thenable and trips the floating-promise lint.
    new Setting(contentEl)
      .setName("Group by")
      .setDesc(
        "A day or a week is one row: its newest snapshot, compared against the one before " +
          "the group. Fewer rows reach much further back, and cost one request each."
      )
      .addDropdown((d) => {
        for (const g of HISTORY_GRANULARITIES) d.addOption(g, GRANULARITY_LABELS[g]);
        d.setValue(this.#granularity);
        d.onChange((value) => {
          if (!isHistoryGranularity(value)) return;
          this.#granularity = value;
          this.deps.rememberGranularity(value);
          void this.#renderList();
        });
      });

    // Deliberately not remembered: a range is a question being asked now, and restoring last
    // week's on the next opening would silently hide history the user did not mean to hide.
    new Setting(contentEl)
      .setName("Between")
      .setDesc("Optional. Leave both empty for the most recent history.")
      .addText((t) => {
        t.inputEl.type = "date";
        t.setPlaceholder("from");
        t.onChange((value) => {
          this.#setRange("from", value);
        });
      })
      .addText((t) => {
        t.inputEl.type = "date";
        t.setPlaceholder("to");
        t.onChange((value) => {
          this.#setRange("to", value);
        });
      });
  }

  /**
   * Takes a date field's new value, and relists only if it changed what the list would be.
   *
   * A field can report every keystroke, and a half-typed date parses to nothing — so without
   * this, typing `2026-08-20` would fire a run of identical unfiltered listings, each one a
   * request, before the one that matters.
   */
  #setRange(which: "from" | "to", value: string): void {
    const before = parseDateField(which === "from" ? this.#from : this.#to);
    if (which === "from") this.#from = value;
    else this.#to = value;
    if (parseDateField(value) === before) return;
    void this.#renderList();
  }

  async #renderList(): Promise<void> {
    const list = this.#listEl;
    if (list === null) return;
    const generation = ++this.#generation;
    list.empty();
    const status = list.createEl("p", { text: "Loading…" });

    const from = parseDateField(this.#from);
    const to = parseDateField(this.#to);
    const opts: HistoryOptions = { changes: true, granularity: this.#granularity };
    if (from !== null) opts.from = from;
    // The field names a day the user wants included, so the range runs to the end of it.
    if (to !== null) opts.to = nextLocalDay(to);

    let listing: HistoryListing;
    try {
      listing = await this.deps.listHistory(this.deps.historyLimit, opts);
    } catch (e) {
      if (generation !== this.#generation) return;
      status.setText(`Could not read history: ${message(e)}`);
      return;
    }
    // A slower earlier request landing after a newer one would redraw the list the user just
    // navigated away from, under controls that no longer describe it.
    if (generation !== this.#generation) return;

    if (listing.rows.length === 0) {
      // Three different truths, and only one of them is "this vault is new". Saying that for
      // either of the others would tell someone their history is gone when it is not.
      status.setText(this.#emptyLine(listing, from !== null || to !== null));
      return;
    }
    status.setText(this.#summaryLine(listing));

    for (const snap of listing.rows) this.#renderRow(list, snap);

    if (listing.more) {
      list.createEl("p", {
        text:
          "Older snapshots exist past this list. Raise “rows listed in history” in settings, " +
          "or narrow the dates, to reach them.",
      });
    }
  }

  /** Why a listing came back with nothing, distinguishing the reasons rather than guessing. */
  #emptyLine(listing: HistoryListing, ranged: boolean): string {
    // "Nothing in that range" is a claim about the vault. It cannot be made when the dates were
    // never actually searched — only the most recent syncs were, and the range may be older.
    if (listing.fallback === "no-range") {
      return (
        "This vault's history index cannot be read, so dates could not be searched. None of " +
        "the most recent syncs fall in that range; older ones were not looked at."
      );
    }
    if (ranged) return "No snapshots in that range.";
    // Snapshots exist, but not enough of the chain was reachable to complete a single bucket —
    // a bucket is only shown once its older edge is known. Rare, and never "this vault is new".
    if (listing.more) {
      return (
        `There is history here, but this window could not reach far enough back to complete a ` +
        `whole ${listing.granularity}. Switch to “Every sync” to see it.`
      );
    }
    return "The remote has no snapshots yet.";
  }

  /** What the list is, including anything it could not do. Never silently a different thing. */
  #summaryLine(listing: HistoryListing): string {
    const unit =
      listing.granularity === "sync"
        ? "Newest first, with what each sync changed."
        : `Newest first, one row per ${listing.granularity}, with what each one changed.`;
    const retention =
      " Older snapshots are removed by the server's retention policy, so this list can be " +
      "shorter than the vault's full history.";
    if (listing.fallback === "no-range") {
      return (
        `${unit} This vault's history index cannot be read, so dates could not be searched: ` +
        `only the most recent syncs were looked at, and anything older than those is not shown ` +
        `whether or not it falls in the range.${retention}`
      );
    }
    if (listing.fallback === "no-index") {
      return (
        `${unit} Grouping needs the server's history index, which this vault has not finished ` +
        `building, so every sync is listed instead.${retention}`
      );
    }
    if (listing.fallback === "no-cursor") {
      return (
        `${unit} This server is too old to page further back, so the list stops at its first ` +
        `page.${retention}`
      );
    }
    return unit + retention;
  }

  #renderRow(list: HTMLElement, snap: SnapshotInfo): void {
    const name =
      snap.group === undefined
        ? `${new Date(snap.createdAt).toLocaleString()} — ${snap.device}`
        : `${describeGroup(snap.group)} — ${describeDevices(snap)}`;
    const summary = snap.changes === undefined ? null : describeChanges(snap.changes);
    const setting = new Setting(list)
      .setName(name)
      .setDesc(
        snap.readable
          ? `${summary ?? `${snap.fileCount} file(s)`} · ${snap.fileCount} file(s) total · ${shortSnapshot(snap.id)}`
          : `unreadable with this device's key · ${shortSnapshot(snap.id)}`
      );
    if (!snap.readable) return;
    setting.addButton((b) => {
      b.setButtonText("Browse").onClick(() => {
        this.close();
        new SnapshotModal(this.app, this.deps, snap).open();
      });
    });

    // The changed paths themselves, capped: the whole point is seeing what moved without
    // opening anything, but a window of forty rows cannot carry forty full file lists.
    const changes = snap.changes;
    if (changes === undefined || "unknown" in changes || changes.files.length === 0) return;
    const files = list.createDiv();
    for (const change of changes.files.slice(0, CHANGE_PREVIEW)) {
      files.createEl("p", { text: describeChangedFile(change) });
    }
    if (changes.files.length > CHANGE_PREVIEW) {
      files.createEl("p", {
        text: `…and ${changes.files.length - CHANGE_PREVIEW} more — Browse to see them all.`,
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** One snapshot's contents, with per-file and whole-vault restore. */
export class SnapshotModal extends Modal {
  /** Ranked most recently edited first, which is the order the file list is read in. */
  #files: Array<{ path: string; entry: FileEntry }> = [];
  #filter = "";
  #listEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly deps: HistoryDeps,
    private readonly snap: SnapshotInfo
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Snapshot contents" });
    contentEl.createEl("p", {
      text: `${new Date(this.snap.createdAt).toLocaleString()} — ${this.snap.device} — ${shortSnapshot(this.snap.id)}`,
    });

    try {
      const files = await this.deps.snapshotFiles(this.snap.id);
      this.#files = Object.entries(files)
        .map(([path, entry]) => ({ path, entry }))
        // "What did I touch recently" is the question someone browsing history has; a path
        // sort answers a different one. Ties break on path so the order is stable.
        .sort((a, b) => b.entry.mtime - a.entry.mtime || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    } catch (e) {
      contentEl.createEl("p", { text: `Could not read this snapshot: ${message(e)}` });
      return;
    }

    const changes = this.snap.changes;
    if (changes !== undefined && !("unknown" in changes) && changes.files.length > 0) {
      contentEl.createEl("h3", { text: `Changed in this snapshot (${changes.files.length})` });
      for (const change of changes.files) {
        contentEl.createEl("p", { text: describeChangedFile(change) });
      }
    }

    new Setting(contentEl)
      .setName("Restore the whole vault to this snapshot")
      .setDesc(
        "Writes every file below and removes synced files this snapshot does not have. " +
          "Files whose current version was published stay recoverable from the history; " +
          "edits this device has never synced would be lost."
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

    const matches = this.#files.filter((f) => f.path.toLowerCase().includes(this.#filter));
    list.createEl("p", {
      text: `${matches.length} of ${this.#files.length} file(s), most recently edited first`,
    });

    for (const { path, entry } of matches.slice(0, 100)) {
      new Setting(list)
        .setName(path)
        .setDesc(`edited ${new Date(entry.mtime).toLocaleString()} · ${fmtBytes(entry.size)}`)
        .addButton((b) => b.setButtonText("Restore").onClick(() => this.#restore(path)));
    }
    if (matches.length > 100) {
      list.createEl("p", { text: `…and ${matches.length - 100} more. Narrow the filter to see them.` });
    }
  }

  /**
   * Restoring never overwrites the live file by accident.
   *
   * Content already identical is a no-op worth saying out loud; a free path is written in
   * place, because there is nothing there to protect; anything else is the user's decision to
   * make, with what is at stake spelled out first.
   */
  async #restore(path: string): Promise<void> {
    let seen: RestoreInspection;
    try {
      seen = await this.deps.inspectRestore(this.snap.id, path);
    } catch (e) {
      new Notice(`Could not restore ${path}: ${message(e)}`, 10_000);
      return;
    }
    if (seen.current === "identical") {
      new Notice(`${path} is already identical to this snapshot — nothing to restore`);
      return;
    }
    if (seen.current === "absent") {
      // Bound to "nothing was there", so a file that appears in the meantime is not clobbered
      // by a decision taken before it existed.
      await this.#run(path, { expectedHash: seen.currentHash });
      return;
    }
    new RestoreDestinationModal(this.app, {
      path,
      inspection: seen,
      onRestore: (choice) => this.#run(path, choice),
    }).open();
  }

  async #run(
    path: string,
    choice: { destination?: string; overwrite?: boolean; expectedHash?: string | null }
  ): Promise<void> {
    try {
      const out = await this.deps.restoreFile(this.snap.id, path, choice);
      // A restore no longer asks the sync policy for permission, so the policy has to be
      // reported instead: a file written onto a path this device does not scan is never
      // published, and "Restored" alone would let the user assume it now is.
      const local = out.kind !== "identical" && !this.deps.syncsPath(out.path);
      new Notice(describeRestore(out) + (local ? unsyncedPathNote(out.path) : ""), local ? 10_000 : undefined);
    } catch (e) {
      new Notice(`Could not restore ${path}: ${message(e)}`, 10_000);
    }
  }

  #confirmRestoreAll(): void {
    new ConfirmModal(this.app, {
      title: "Restore the whole vault?",
      body: [
        `Every file this device syncs will be made to match snapshot ${shortSnapshot(this.snap.id)}. Files ` +
          `added since then will be moved to the trash.`,
        `Anything whose current version was published stays in the snapshot history and can ` +
          `be restored the same way. Edits made since the last sync have never left this ` +
          `device, and this will overwrite them. Sync first if you want them kept.`,
      ],
      phrase: "RESTORE",
      onConfirm: async () => {
        const notice = new Notice("Restoring…", 0);
        try {
          const { written, removed } = await this.deps.restoreAll(this.snap.id);
          new Notice(`Restored ${written} file(s), removed ${removed}. Syncing to publish it.`);
          this.close();
          await this.deps.syncNow();
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

/**
 * What replacing a file costs, said the same way wherever it is said.
 *
 * Never promises the version being replaced is recoverable. Matching this device's last synced
 * state does not prove any *retained* snapshot still references those bytes — the device may
 * have been offline past the retention window, or the chain rerooted — and a safety claim that
 * turns out to be false is what motivates an irreversible overwrite.
 */
export function unsyncedWarning(unsyncedEdits: boolean): string {
  return unsyncedEdits
    ? "That version has edits this device has never synced — it exists nowhere else, and " +
        "replacing it would destroy it."
    : "That version matches what this device last synced. Whether the remote still keeps a " +
        "snapshot holding it depends on the retention window, so replacing it may still be " +
        "permanent.";
}

/**
 * The caveat on a restore that landed somewhere this device does not sync.
 *
 * Said plainly rather than dressed as a warning: the write succeeded and the file is there. What
 * the user cannot know without being told is that nothing will ever publish it, so it will not
 * appear on another device and will not survive a fresh install of the vault.
 */
export function unsyncedPathNote(path: string): string {
  return (
    ` — but this device does not sync ${path}, so the file stays on this device only and is ` +
    `never published.`
  );
}

/** What a finished restore did, in the words the user needs to find the file afterwards. */
export function describeRestore(out: RestoreOutcome): string {
  switch (out.kind) {
    case "identical":
      return `${out.path} already holds exactly that content — nothing was written`;
    case "written":
      return `Restored ${out.path}`;
    case "replaced":
      return `Replaced ${out.path} with the snapshot's version`;
    case "copied":
      return `${out.requested} already held different content, so the snapshot's version was saved as ${out.path}`;
  }
}

/**
 * Where a restored file should go, when something different is already at its original path.
 *
 * The default is a copy, because the alternative destroys work: the live file may hold edits
 * that were never synced, and this window is the only place that difference is visible. The
 * overwrite is still offered — it is a legitimate thing to want — but it is the second button
 * and it says what it costs.
 */
export class RestoreDestinationModal extends Modal {
  constructor(
    app: App,
    private readonly opts: {
      path: string;
      inspection: RestoreInspection;
      onRestore: (choice: {
        destination?: string;
        overwrite?: boolean;
        expectedHash?: string | null;
      }) => void | Promise<void>;
    }
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    const { path, inspection } = this.opts;
    contentEl.empty();
    contentEl.createEl("h2", { text: `Restore ${path}` });
    contentEl.createEl("p", {
      text: `A different version of this file is at ${path} right now.`,
    });
    contentEl.createEl("p", { text: unsyncedWarning(inspection.unsyncedEdits) });

    let destination = inspection.suggestion;
    new Setting(contentEl)
      .setName("Save the restored copy as")
      .setDesc("Anywhere in the vault. A name already taken by different content gets numbered.")
      .addText((t) =>
        t.setValue(destination).onChange((v) => {
          destination = v.trim();
        })
      );

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText("Save a copy")
          .setCta()
          .onClick(async () => {
            if (destination === "") {
              new Notice("Give the restored copy a path");
              return;
            }
            this.close();
            await this.opts.onRestore({ destination });
          })
      )
      .addButton((b) =>
        b
          .setButtonText("Replace current file")
          .setWarning()
          .onClick(() => {
            // Asked a second time because this is the one button here that destroys
            // something: the copy path invents a new file, this one overwrites a note whose
            // current contents may never have been synced anywhere. The window it sits in was
            // raised by the restore, not chosen — so reaching it is not the same as meaning
            // it. No typed phrase: this is one file, not the whole vault.
            new ConfirmModal(this.app, {
              title: "Replace the current file?",
              body: [
                `${this.opts.path} will be overwritten with the version from this snapshot. ` +
                  "What is there now is replaced, not moved aside.",
                unsyncedWarning(inspection.unsyncedEdits),
              ],
              confirmText: "Replace it",
              cancelText: "Keep what is there",
              onConfirm: async () => {
                this.close();
                // The version the paragraphs above described, not whatever is there by the
                // time this write lands. The engine refuses the write if they differ.
                await this.opts.onRestore({
                  overwrite: true,
                  expectedHash: inspection.currentHash,
                });
              },
            }).open();
          })
      )
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
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
  /** Its own list: resolving one removes it here, and the plugin keeps its own record. */
  #conflicts: ConflictInfo[];
  /** One resolution at a time. A second click on a button mid-write resolves nothing twice. */
  #busy = false;
  /**
   * Every choice button currently on screen, rebuilt by each `#render()`.
   *
   * A resolution moves files that the *other* rows describe, so accepting one click has to
   * take all of them out of service — not just the four in the row that was pressed.
   */
  #choiceButtons: Array<{ setDisabled(v: boolean): unknown }> = [];

  constructor(
    app: App,
    conflicts: readonly ConflictInfo[],
    private readonly actions: {
      readText: (path: string) => Promise<string | null>;
      resolve: (
        info: ConflictInfo,
        choice: ConflictChoice,
        hooks?: ExclusiveHooks
      ) => Promise<void>;
    } | null = null,
    /**
     * Which of the pairs' files are on disk right now. Empty means "not checked", which is
     * how the preview call site and older tests get every button — the window must not
     * disable everything just because nobody looked.
     */
    private readonly present: ReadonlySet<string> = new Set()
  ) {
    super(app);
    this.#conflicts = [...conflicts];
  }

  /** Null when the check was never run, so "unknown" and "missing" stay different answers. */
  #blocked(c: ConflictInfo, choice: ConflictChoice): string | null {
    return this.present.size === 0 ? null : choiceBlockedReason(c, choice, this.present);
  }

  onOpen(): void {
    this.#render();
  }

  #render(): void {
    const { contentEl } = this;
    contentEl.empty();
    // The old buttons are gone with the DOM; keeping references would disable nothing.
    this.#choiceButtons = [];
    const outstanding = this.#conflicts;
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
        outstanding.every((c) => isResolvable(c))
          ? "Both sides changed these files in ways that could not be merged. Both versions " +
            "are on disk; pick one, or combine them into a single file to sort out by hand."
          : "Both sides changed these files in ways that could not be merged. Where both " +
            "versions are on this device you can pick one, or combine them into a single " +
            "file; each entry says what it has.",
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

      const blocked = unresolvableReason(c);
      if (blocked !== null) {
        list.createEl("li", { text: blocked });
        continue;
      }
      // Which file holds which version, said plainly: an attachment that lost the path keeps
      // THIS device's version in the copy, and a user about to delete one deserves to know.
      const sides = conflictSides(c);
      list.createEl("li", { text: `This device's version is in: ${sides.mine}` });
      list.createEl("li", { text: `The other device's version is in: ${sides.theirs}` });
      // Named explicitly, because the buttons below go quiet on the strength of it and a
      // disabled button with no stated reason reads as a broken window.
      const gone = this.present.size === 0 ? [] : missingSides(c, this.present);
      if (gone.length > 0) {
        list.createEl("li", {
          text:
            `No longer in the vault: ${gone.join(", ")}. Only the choices that do not need ` +
            "it are still available.",
        });
      }
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
      // By side, not by position: the canonical path holds THEIRS whenever an attachment
      // conflict resolved to last-writer-wins, and a diff drawn the other way round labels
      // every line with the wrong device.
      const sides = conflictSides(c);
      const mine = await this.actions!.readText(sides.mine);
      const theirs = await this.actions!.readText(sides.theirs);
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
        pre.createDiv({
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
        const blocked = this.#blocked(c, choice);
        if (blocked !== null) b.setDisabled(true).setTooltip(blocked);
        this.#choiceButtons.push(b);
        b.setButtonText(text).onClick(async () => {
          // Belt and braces: the button is disabled, and the fake used in tests still fires
          // a disabled button's handler. A click that cannot succeed must not half-run.
          if (blocked !== null) return;
          // A resolution is several file operations; a second click landing between them
          // resolves an already-resolved pair and reports a failure for work that succeeded.
          if (this.#busy) return;
          this.#busy = true;
          // Synchronously, in the same tick as the click: the wait can be a whole sync pass
          // plus its retry backoff, and a window that looks identical before and after the
          // press is how a working button gets reported as dead.
          for (const other of this.#choiceButtons) other.setDisabled(true);
          b.setButtonText(RESOLVING_LABEL);
          try {
            await this.actions!.resolve(c, choice, {
              // Block bodies: a `Setting`/`ButtonComponent` is structurally thenable, so
              // returning one from a void callback trips the promise lint.
              onQueued: () => {
                b.setButtonText(QUEUED_LABEL);
              },
              onStart: () => {
                b.setButtonText(RESOLVING_LABEL);
              },
            });
            new Notice(`R2DO Sync: ${c.path} resolved`);
            this.#conflicts = this.#conflicts.filter((other) => other !== c);
            this.#render();
          } catch (e) {
            new Notice(`R2DO Sync could not resolve ${c.path}: ${message(e)}`, 10_000);
            // Rebuilt rather than re-enabled one by one: `#render` is what decides which
            // choices are possible at all, and a failure must not resurrect an impossible one.
            this.#render();
          } finally {
            this.#busy = false;
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

    const uri = encodeSetupUri(payload);
    this.#warn(out, "QR");
    renderQr(out, uri);
    out.createEl("p", {
      text: "On the other device: open the camera app, scan, and confirm when Obsidian opens.",
    });
    // The same payload in a form a camera is not needed for. A code drawn without the link
    // beside it left "copy the link" as an invisible second step behind another button — and
    // a phone scanner that opens obsidian:// in a browser makes the link the only way through.
    this.#linkField(out, uri);
  }

  async #copy(out: HTMLElement): Promise<void> {
    out.empty();
    const payload = this.#payload();
    if (payload === null) return;

    const uri = encodeSetupUri(payload);
    this.#warn(out, "link");
    const field = this.#linkField(out, uri);
    out.createEl("p", {
      text:
        "On the other device: Settings → R2DO Sync → Apply a setup link → Paste link. " +
        "Clear your clipboard afterwards.",
    });
    // The clipboard is a convenience over the field, not the only route: a platform that
    // refuses it leaves the link on screen to select by hand.
    await copySecret(uri, field, "Setup link");
  }

  /**
   * The link itself, on screen and selectable, with a button for the ordinary case.
   *
   * A secret that only ever exists on the clipboard cannot be checked, cannot be read out,
   * and is gone the moment anything else is copied.
   */
  /**
   * The link, under a heading that says what it is.
   *
   * Order matters: the row is placed before the box so the box is never an unlabelled
   * mystery, and the button is attached afterwards so the field it copies already exists.
   */
  #linkField(out: HTMLElement, uri: string): HTMLTextAreaElement {
    const row = new Setting(out)
      .setName("Setup link")
      .setDesc(
        "The same thing the code carries, as text — for a device with no camera, or a scanner " +
          "that opens the link in a browser instead of Obsidian. Paste it into the other " +
          "device with \"Apply a setup link\"."
      );
    const field = secretField(out, uri, "Setup link");
    row.addButton((b) =>
      b.setButtonText("Copy link").onClick(() => void copySecret(uri, field, "Setup link"))
    );
    return field;
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

  /**
   * Why the mobile status-bar override could not be installed, or `null`. Kept across a
   * `display()` because the redraw that shows it is the one the failure triggered.
   */
  mobileStatusBarError: string | null = null;

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
            const shown =
              head === null
                ? "(empty vault)"
                : shortSnapshot(head);
            new Notice(`R2DO Sync OK. Remote head: ${shown}`);
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

    // Here rather than in a catch-all section: it is this device's relationship with the
    // others, which is what the rest of this section is about.
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
        // Nothing is synced yet, so no snapshot has to be migrated — but this device may
        // already hold the vault's key, typed in from another device and not yet used. A new
        // one would replace it silently, and the vault it opens would then be unreachable
        // from here. Creating the FIRST key is not a replacement and is not interrupted: that
        // is the onboarding path, and a confirmation there is noise.
        const replacing = this.plugin.settings.masterKey.trim();
        if (replacing !== "" && replacing !== key.trim()) {
          new ConfirmModal(this.app, {
            title: "Replace the key this device holds?",
            body: [
              "This device already has a vault master key. Replacing it with a new one points " +
                "this device at a different vault, and anything encrypted under the old key " +
                "stays readable only to whoever still has it.",
              "If you have not saved the current key anywhere, copy it out first — this is the " +
                "last moment it exists on this device.",
            ],
            confirmText: "Replace the key",
            cancelText: "Keep the current key",
            onConfirm: run,
          }).open();
          return;
        }
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

    // No separate "Reveal master key" row: the field above has the eye toggle, which shows
    // the same key in place, and handing it to another device is "Set up another device".
    // Three ways to look at one secret is two more places for it to end up on a screen.
    if (this.plugin.encryptionEnabled && hasKey) {
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
    const configDir = configDirOf(this.app);
    const indexed = this.#indexedPaths();
    let onlyHint: HTMLElement | null = null;
    let excludeHint: HTMLElement | null = null;
    const refresh = (): void => {
      if (indexed === null) return;
      const rules = {
        excludes: parseGlobs(excludeDraft),
        onlyPaths: parseGlobs(onlyDraft),
        syncConfigDir: this.plugin.settings.syncConfigDir,
        configDir,
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
      .setDesc(`Includes ${configDir}/** except plugins, themes and snippets, this plugin's live/legacy credential directories, and workspace files. Bad config merges can break plugins.`)
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
              "Obsidian's own configuration JSON is not mergeable like notes. A bad " +
              "cross-device overwrite can corrupt settings. Installed plugins, themes and " +
              "CSS snippets are never synced — Obsidian executes those, and syncing them " +
              "would let anyone who can write to this vault run code on your devices. " +
              "R2DO Sync also excludes its own credentials and workspace layouts.",
            phrase: "SYNC CONFIG",
            onConfirm: async () => {
              this.plugin.settings.syncConfigDir = true;
              await this.plugin.saveSettings();
              this.display();
            },
            onCancel: () => {
              toggle.setValue(false);
            },
          }).open();
        })
      );
  }

  /**
   * How a pass runs and when it starts — direction, timing, and the two knobs that decide how
   * hard it works. They used to sit in an "Advanced" bucket at the far end of the page, which
   * grouped them by how obscure they are rather than by what they do.
   */
  #renderHowItSyncs(containerEl: HTMLElement): void {
    this.#heading(containerEl, "How and when it syncs");

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

    // Mobile only, because that is the only platform where returning to the app is wired to
    // anything. On desktop the row would be a control for nothing.
    if (Platform.isMobile) {
      this.#number(containerEl, {
        name: "Sync on returning to the app (minutes)",
        desc:
          "How long since the last sync before returning to Obsidian starts one. 0 never " +
          "does. Returning fires more often than it sounds — a screen unlock or a pulled-down " +
          "notification shade counts — so this is what stops that becoming a sync each time. " +
          'Needs "Sync on startup" on.',
        value: this.plugin.settings.resumeSyncMinutes,
        range: "0–1440",
        accept: (n) => n >= 0 && n <= 1440,
        apply: (n) => {
          this.plugin.settings.resumeSyncMinutes = n;
        },
      });
    }

    // A row about keystrokes on a device with no keyboard is noise: mobile Obsidian has no
    // Hotkeys page to send anyone to either.
    if (!Platform.isMobile) this.#hotkeyRow(containerEl);

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
  }

  /** What happens when two devices changed the same file, and what is still outstanding. */
  #renderConflicts(containerEl: HTMLElement): void {
    this.#heading(containerEl, "Conflicts");

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
              onCancel: () => {
                d.setValue(previous);
              },
            }).open();
          });
      });

    new Setting(containerEl)
      .setName("Unresolved conflicts")
      .setDesc(
        "Files two devices changed in ways that could not be merged. Where both versions are " +
          "on this device, this shows the difference and lets you keep one, keep both, or " +
          "combine them into a single file."
      )
      .addButton((b) =>
        b
          .setButtonText(
            this.plugin.lastConflicts.length > 0
              ? `Review ${this.plugin.lastConflicts.length}`
              : "None"
          )
          .setDisabled(this.plugin.lastConflicts.length === 0)
          .onClick(() => {
            void this.plugin.openConflictReview();
          })
      );
  }

  /** The guard against a destructive pull, and every way back from one. */
  #renderRecovery(containerEl: HTMLElement): void {
    this.#heading(containerEl, "Safety and recovery");

    // First in the section, because it is the one thing here that is safe to press. Someone
    // who has just lost a note opens this page to find it, and the buttons below are the ones
    // that overwrite vaults — leading with those puts the destructive answers in front of the
    // question most people are actually asking.
    new Setting(containerEl)
      .setName("Snapshot history")
      .setDesc("Browse past snapshots and restore a file or the whole vault.")
      .addButton((b) => b.setButtonText("Browse").onClick(() => void this.plugin.openHistory()));

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
      .setName("Preview sync")
      .setDesc("Shows what a sync would change, without changing anything.")
      .addButton((b) => b.setButtonText("Preview").onClick(() => void this.plugin.previewSync()));

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

    // Last, and warned about hardest: every other action on this page can be undone from
    // Snapshot history, and this is the one that empties it.
    new Setting(containerEl)
      .setName("Rebuild remote history")
      .setDesc(
        "Publishes this device's files as the only snapshot and DISCARDS every earlier one. " +
          "Use it to stop storing something the history still holds, or to start the chain " +
          "over. Nothing it removes can be restored, on any device. The server frees the " +
          "space at a later daily collection, and holds back anything uploaded in the past " +
          "24 hours."
      )
      .addButton((b) =>
        b.setButtonText("Rebuild").setWarning().onClick(() => void this.plugin.rebuildHistory())
      );

    this.#number(containerEl, {
      name: "Rows listed in history",
      desc:
        "How many rows the history browser lists (1–200). Each one is a request. A row is one " +
        "sync, one day or one week, whichever the window is grouped by.",
      value: this.plugin.settings.historyLimit,
      range: "1–200",
      accept: (n) => n >= 1 && n <= 200,
      apply: (n) => {
        this.plugin.settings.historyLimit = n;
      },
    });
  }

  #renderNotices(containerEl: HTMLElement): void {
    this.#heading(containerEl, "Notices");

    // One ordered choice rather than a switch per topic. Independent booleans could express
    // "every pass but never problems" — a stream of "up to date" from a sync that has silently
    // broken — and they left silence as a state the page had to *detect* and warn about
    // instead of something anyone could simply pick.
    new Setting(containerEl)
      .setName("What sync announces")
      .setDesc(
        "Each level also says everything the ones below it would. This is a per-device " +
          "setting: quiet on a phone and loud on a desktop is the ordinary case."
      )
      .addDropdown((d) =>
        d
          .addOption("all", 'All — every pass, "up to date" included')
          .addOption("activity", "Activity — only passes that changed something")
          .addOption("problems", "Problems — conflicts and errors only")
          .addOption("silent", "Silent — nothing")
          .setValue(this.plugin.settings.noticeLevel)
          .onChange(async (v) => {
            this.plugin.settings.noticeLevel = v as NoticeLevel;
            await this.plugin.saveSettings();
            // Redrawn because the warning below belongs to one choice only. Appending it would
            // stack a second copy every time the level changed.
            this.display();
          })
      );

    if (this.plugin.settings.noticeLevel === "silent") {
      // Silence is a state someone can choose deliberately, so it has to be visible rather
      // than merely reachable: a device that has quietly stopped reporting failures otherwise
      // looks exactly like one that has nothing to report.
      containerEl.createEl("p", {
        cls: "r2do-hint",
        text:
          (Platform.isMobile
            ? "Sync will not say anything at all — failures included. It keeps running and " +
              "keeps recording what it did. Turn on the status bar below, or nothing on " +
              "screen will tell you a sync has started failing."
            : "Sync will not say anything at all — failures included. It keeps running and " +
              "keeps recording what it did: the status bar still shows the state, and the " +
              "sync log still has the detail.") +
          // Silence is the one choice on the page that has to describe itself exactly, and
          // with the switch below on it is silence about the timer only. Leaving the sentence
          // at "nothing at all" would be the page telling the user something untrue about
          // their own settings.
          (this.plugin.settings.alwaysReportManualSync
            ? " This covers sync that runs on its own. A sync you start by hand still reports " +
              "itself, until you turn that off below."
            : ""),
      });
    }

    // The level above governs sync nobody asked for. This governs the answer to a tap, which
    // is the one thing it deliberately never covers — so it sits directly under the level and
    // says so, rather than being discovered later as an exception to it.
    new Setting(containerEl)
      .setName("Always report a sync you start by hand")
      .setDesc(
        'Runs "syncing…" while a sync you started is working and reports what it did when it ' +
          'finishes, whatever the level above says — the ribbon, "Sync now", or a hotkey. Force ' +
          "push, force pull and rebuild history report their result under this too, but they " +
          "announce themselves as they run whatever you set here: those answer a typed " +
          "confirmation, and an answer to a click is never silenced. A timer is untouched — it " +
          "has nobody waiting on it, which is the whole reason the level exists. What the " +
          'summary contains is still yours: turn on "List the changed files" below for names, ' +
          "or leave it off for counts."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.alwaysReportManualSync).onChange(async (v) => {
          this.plugin.settings.alwaysReportManualSync = v;
          await this.plugin.saveSettings();
          // Redrawn because the opener below is the one thing this subsumes: while it is on,
          // that switch has no state it can express. A dead control left on screen is worse
          // than one that steps aside.
          this.display();
        })
      );

    if (!this.plugin.settings.alwaysReportManualSync) {
      new Setting(containerEl)
        .setName("Say when a sync starts")
        .setDesc(
          'Shows "syncing…" while a sync you started is running, and only then — a timer has ' +
            "nobody to reassure. Kept out of the level above because it answers your tap rather " +
            "than describing the vault, so it still works at Problems and Silent. With the " +
            "switch above off, this is the only reply a manual sync that found nothing gives " +
            "you: leave it on if you sync by hand."
        )
        .addToggle((t) =>
          t.setValue(this.plugin.settings.notifyOnStart).onChange(async (v) => {
            this.plugin.settings.notifyOnStart = v;
            await this.plugin.saveSettings();
          })
        );
    }

    new Setting(containerEl)
      .setName("List the changed files")
      .setDesc(
        "Names each file that moved, with its line change and the snapshot id, instead of " +
          "counts alone. Long lists are cut off. A line count is net — 5 lines replaced by 5 " +
          "others reads as 0 — and binary files have none. Shapes the pass summary, so it " +
          "needs All or Activity above."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.verboseSyncNotice).onChange(async (v) => {
          this.plugin.settings.verboseSyncNotice = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Show the current snapshot")
      .setDesc(
        'Adds a line — "head at kmnpqrs" — to every pass notice, including a pass that changed ' +
          'nothing, which is the point: "up to date" does not say up to date with what. The ' +
          "last 7 characters, the random half of the id; the first ten are a timestamp and " +
          "would look nearly the same on every snapshot. It is the same id the history window " +
          "lists, so you can match one to the other."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showHeadInNotice).onChange(async (v) => {
          this.plugin.settings.showHeadInNotice = v;
          await this.plugin.saveSettings();
        })
      );

    // Switch and text in one row, switch first. As two rows the field came before the control
    // deciding whether it mattered, and their pairing had to be explained rather than shown.
    new Setting(containerEl)
      .setName("Label")
      .setDesc(
        "Put in front of every notice above. It is repeated on every pass forever, so a " +
          "shorter name — or none — buys back a useful amount of a phone screen. The switch " +
          "is separate from the text so turning it off does not throw away what you typed; a " +
          "blank name behaves the same as off."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showNoticePrefix).onChange(async (v) => {
          this.plugin.settings.showNoticePrefix = v;
          await this.plugin.saveSettings();
        })
      )
      .addText((t) => {
        let stored = this.plugin.settings.noticePrefix;
        t.setValue(stored);
        this.#stage(t.inputEl, async () => {
          const entered = t.inputEl.value;
          if (entered === stored) return;
          stored = entered;
          this.plugin.settings.noticePrefix = entered;
          await this.plugin.saveSettings();
        });
      });

    if (Platform.isMobile) this.#mobileStatusBarRow(containerEl);
  }

  /**
   * The mobile status bar toggle. Mobile only, because on desktop the bar is already there and
   * an override that does nothing is worse than no setting at all.
   */
  #mobileStatusBarRow(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Show the status bar on mobile")
      .setDesc(
        "Obsidian hides the status bar on phones. This forces it back, so sync state is " +
          "readable without notices — necessary if you turn on Silent sync. It overrides " +
          "Obsidian's own layout, so turn it off again if anything looks wrong."
      )
      .addToggle((t) => {
        t.setValue(this.plugin.settings.mobileStatusBar).onChange(async (v) => {
          this.plugin.settings.mobileStatusBar = v;
          await this.plugin.saveSettings();
          this.mobileStatusBarError = this.plugin.applyMobileStatusBar();
          // Redrawn rather than appended: a toggle flipped twice would otherwise stack a
          // second copy of the same complaint under the row.
          this.display();
        });
      });
    // Said beside the control that caused it rather than in a notice — the user is looking at
    // this row, and a device that just asked for silence would not be shown a notice anyway.
    if (this.mobileStatusBarError !== null) {
      containerEl.createEl("p", { text: this.mobileStatusBarError, cls: "r2do-error" });
    }
  }

  /** The exported log and the two knobs that shape it. */
  #renderTroubleshooting(containerEl: HTMLElement): void {
    this.#heading(containerEl, "Troubleshooting");

    new Setting(containerEl)
      .setName("Sync log")
      .setDesc("Writes the recent sync passes to a note in this vault, for troubleshooting.")
      .addButton((b) => b.setButtonText("Export").onClick(() => void this.plugin.exportLog()));

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

    // Grouped by what each part of the plugin does, so a knob sits with the thing it tunes:
    // the retry count beside the schedule, the history depth beside the history browser, the
    // log length beside the export. The old "Advanced" section grouped by how obscure a
    // setting looked instead, which split every feature across two places on the page.
    this.#renderOverview(containerEl);
    this.#renderConnection(containerEl);
    this.#renderThisDevice(containerEl);
    this.#renderEncryption(containerEl);
    this.#renderScope(containerEl);
    this.#renderHowItSyncs(containerEl);
    this.#renderConflicts(containerEl);
    this.#renderRecovery(containerEl);
    this.#renderNotices(containerEl);
    this.#renderTroubleshooting(containerEl);
  }
}
