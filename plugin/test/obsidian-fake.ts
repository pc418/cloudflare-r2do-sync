// Minimal stand-in for the `obsidian` module so settings-tab rendering is testable in node.
// Vitest aliases "obsidian" here (see vitest.config.ts). It models only the surface the
// plugin's UI actually touches, and records what was rendered so tests can assert on the
// result rather than on a real DOM.

export type RenderedKind = "text" | "textarea" | "toggle" | "dropdown" | "button" | "extra-button";

export interface RenderedSetting {
  name: string;
  desc: string;
  controls: RenderedKind[];
  /**
   * The heading this row rendered under, which is the only record of it: `setHeading()` takes
   * a heading back out of the settings list, so nothing else relates the two. Grouping is
   * what the page is *for* — a row filed under the wrong part is a row nobody finds.
   */
  section: string;
}

/** Everything a container has rendered, in order. */
export interface RenderLog {
  headings: string[];
  paragraphs: string[];
  settings: RenderedSetting[];
  /** The live settings, index-aligned with `settings`, so a test can activate a control. */
  rows: Setting[];
}

export function newRenderLog(): RenderLog {
  return { headings: [], paragraphs: [], settings: [], rows: [] };
}

class FakeInput {
  type = "text";
  value = "";
  rows = 0;
  readonly classes: string[] = [];
  private readonly listeners = new Map<string, Array<(arg?: unknown) => void>>();
  addEventListener(event: string, fn: (arg?: unknown) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(fn);
    this.listeners.set(event, list);
  }
  addClass(cls: string): void {
    this.classes.push(cls);
  }
  removeClass(): void {}
  focus(): void {}
  select(): void {}
  /**
   * Test helper: fire a listener the UI registered (blur staging, Enter, …). The argument is
   * the event, because a field that commits on Enter has to be told which key was pressed.
   */
  fire(event: string, arg?: unknown): void {
    for (const fn of this.listeners.get(event) ?? []) fn(arg);
  }
}

export class FakeElement {
  readonly children: FakeElement[] = [];
  // Enough of a textarea to model the secret-bearing ones the UI falls back to when the
  // clipboard is unavailable: the value must be readable, and "was it offered for manual
  // selection" is the difference between a dead end and a working escape hatch.
  value = "";
  readOnly = false;
  rows = 0;
  selected = false;
  /** Where this element's text is recorded, so later writes to it stay visible to tests. */
  #recordedIn: string[] | null = null;
  #recordedAt = -1;
  constructor(
    readonly tag: string,
    public text: string,
    readonly log: RenderLog,
    readonly cls: string = "",
    readonly href: string = "",
    /** True for a container the UI itself owns and re-renders wholesale. */
    readonly root: boolean = false
  ) {}
  focus(): void {}
  select(): void {
    this.selected = true;
  }
  setAttr(): void {}
  /**
   * Clearing a container the UI owns (a settings page, a modal body) resets the record with
   * it. Clearing a nested div does not: the UI empties those to redraw one region — an export
   * that is no longer valid, say — and the rest of the page it sits in is still on screen.
   */
  empty(): void {
    this.children.length = 0;
    this.text = "";
    this.#rerecord();
    if (!this.root) return;
    this.log.headings.length = 0;
    this.log.paragraphs.length = 0;
    this.log.settings.length = 0;
    this.log.rows.length = 0;
  }
  createEl(tag: string, opts?: { text?: string; cls?: string; href?: string }): FakeElement {
    const el = new FakeElement(tag, opts?.text ?? "", this.log, opts?.cls ?? "", opts?.href ?? "");
    this.children.push(el);
    if (tag === "h3" || tag === "h2") el.#recordIn(this.log.headings);
    if (tag === "p") el.#recordIn(this.log.paragraphs);
    // A paragraph built from inline children (<strong>, <a>) still reads as one string, the
    // way textContent does. Without this, prose split across children vanishes from the log.
    // Only for elements whose own text is recorded: a container div that absorbed everything
    // its children ever held would still read as full after it is emptied.
    if (el.text !== "" && this.#recordedIn !== null) this.#grow(el.text);
    return el;
  }
  /** Obsidian's own DOM extension: text appended around inline children. */
  appendText(value: string): this {
    this.#grow(value);
    return this;
  }
  #recordIn(sink: string[]): void {
    this.#recordedIn = sink;
    this.#recordedAt = sink.length;
    sink.push(this.text);
  }
  #grow(value: string): void {
    this.text += value;
    this.#rerecord();
  }
  #rerecord(): void {
    const sink = this.#recordedIn;
    // A stale element (its container was emptied) must not write into the cleared log.
    if (sink !== null && this.#recordedAt < sink.length) sink[this.#recordedAt] = this.text;
  }
  createDiv(opts?: { text?: string; cls?: string }): FakeElement {
    return this.createEl("div", opts);
  }
  /**
   * The QR code is built as inline SVG through `document.createElementNS` and appended here,
   * so this records the node without modelling one: "was a code drawn" is the question, and
   * the modules inside it are the QR library's business.
   */
  appendChild(child: { tagName?: string }): FakeElement {
    const el = new FakeElement(child.tagName ?? "node", "", this.log);
    this.children.push(el);
    return el;
  }
  /** Every text in this subtree, in render order. */
  texts(): string[] {
    return this.children.flatMap((c) => [c.text, ...c.texts()]).filter((t) => t !== "");
  }
  /** Elements in this subtree carrying `cls`, for asserting a diff was actually drawn. */
  byClass(cls: string): FakeElement[] {
    return this.children.flatMap((c) => [...(c.cls === cls ? [c] : []), ...c.byClass(cls)]);
  }
  setText(value: string): void {
    this.text = value;
    this.#rerecord();
  }
  addClass(): void {}
  removeClass(): void {}
  setAttribute(): void {}
}

export function fakeContainer(log = newRenderLog()): FakeElement {
  return new FakeElement("div", "", log, "", "", true);
}

export class TextComponent {
  readonly inputEl = new FakeInput();
  private changeHandler: ((v: string) => unknown) | null = null;
  setValue(v: string): this {
    this.inputEl.value = v;
    return this;
  }
  getValue(): string {
    return this.inputEl.value;
  }
  setPlaceholder(): this {
    return this;
  }
  onChange(fn: (v: string) => unknown): this {
    this.changeHandler = fn;
    return this;
  }
  /** Test helper: simulate typing. */
  change(v: string): unknown {
    this.inputEl.value = v;
    return this.changeHandler?.(v);
  }
}

export class ToggleComponent {
  private value = false;
  private changeHandler: ((v: boolean) => unknown) | null = null;
  setValue(v: boolean): this {
    this.value = v;
    return this;
  }
  getValue(): boolean {
    return this.value;
  }
  onChange(fn: (v: boolean) => unknown): this {
    this.changeHandler = fn;
    return this;
  }
  change(v: boolean): unknown {
    this.value = v;
    return this.changeHandler?.(v);
  }
}

export class DropdownComponent {
  readonly options: string[] = [];
  private value = "";
  private changeHandler: ((v: string) => unknown) | null = null;
  addOption(value: string): this {
    this.options.push(value);
    return this;
  }
  setValue(v: string): this {
    this.value = v;
    return this;
  }
  getValue(): string {
    return this.value;
  }
  onChange(fn: (v: string) => unknown): this {
    this.changeHandler = fn;
    return this;
  }
  change(v: string): unknown {
    this.value = v;
    return this.changeHandler?.(v);
  }
}

export class ButtonComponent {
  text = "";
  icon = "";
  /** Recorded because "which side is the default" is user-visible behaviour worth asserting. */
  cta = false;
  /** Likewise: a button offered for something that cannot be done is a dead end. */
  disabled = false;
  private clickHandler: (() => unknown) | null = null;
  setButtonText(v: string): this {
    this.text = v;
    return this;
  }
  setIcon(v: string): this {
    this.icon = v;
    return this;
  }
  setTooltip(): this {
    return this;
  }
  setWarning(): this {
    return this;
  }
  setCta(): this {
    this.cta = true;
    return this;
  }
  setDisabled(v = true): this {
    this.disabled = v;
    return this;
  }
  onClick(fn: () => unknown): this {
    this.clickHandler = fn;
    return this;
  }
  /** Test helper: activate the control the UI wired up. */
  click(): unknown {
    return this.clickHandler?.();
  }
}

export class Setting {
  readonly rendered: RenderedSetting = { name: "", desc: "", controls: [], section: "" };
  readonly texts: TextComponent[] = [];
  readonly toggles: ToggleComponent[] = [];
  readonly dropdowns: DropdownComponent[] = [];
  readonly buttons: ButtonComponent[] = [];

  // Registered on construction, so a throw part-way through a chain still shows how far
  // rendering got — that is exactly the failure this fake exists to catch.
  constructor(private readonly container: FakeElement) {
    // Stamped on construction, before this row knows whether it is itself a heading: a
    // heading is removed from the list again by `setHeading()`.
    this.rendered.section = container.log.headings.at(-1) ?? "";
    container.log.settings.push(this.rendered);
    container.log.rows.push(this);
  }
  setName(name: string): this {
    this.rendered.name = name;
    return this;
  }
  setDesc(desc: string): this {
    this.rendered.desc = desc;
    return this;
  }
  /**
   * A section title, which is what Obsidian renders this as. Recorded as a heading and taken
   * back out of the settings list: counting it as a setting would fail "every setting has a
   * control" for something that is not one.
   */
  setHeading(): this {
    const log = this.container.log;
    const at = log.settings.indexOf(this.rendered);
    if (at >= 0) {
      log.settings.splice(at, 1);
      log.rows.splice(at, 1);
    }
    log.headings.push(this.rendered.name);
    return this;
  }
  addText(cb: (t: TextComponent) => unknown): this {
    const t = new TextComponent();
    this.texts.push(t);
    this.rendered.controls.push("text");
    cb(t);
    return this;
  }
  addTextArea(cb: (t: TextComponent) => unknown): this {
    const t = new TextComponent();
    this.texts.push(t);
    this.rendered.controls.push("textarea");
    cb(t);
    return this;
  }
  addToggle(cb: (t: ToggleComponent) => unknown): this {
    const t = new ToggleComponent();
    this.toggles.push(t);
    this.rendered.controls.push("toggle");
    cb(t);
    return this;
  }
  addDropdown(cb: (d: DropdownComponent) => unknown): this {
    const d = new DropdownComponent();
    this.dropdowns.push(d);
    this.rendered.controls.push("dropdown");
    cb(d);
    return this;
  }
  addButton(cb: (b: ButtonComponent) => unknown): this {
    const b = new ButtonComponent();
    this.buttons.push(b);
    this.rendered.controls.push("button");
    cb(b);
    return this;
  }
  addExtraButton(cb: (b: ButtonComponent) => unknown): this {
    const b = new ButtonComponent();
    this.buttons.push(b);
    this.rendered.controls.push("extra-button");
    cb(b);
    return this;
  }
}

export class App {}

export class Plugin {
  constructor(
    readonly app: App,
    readonly manifest: unknown = {}
  ) {}
  addRibbonIcon(): FakeElement {
    return fakeContainer();
  }
  addCommand(): void {}
  addSettingTab(): void {}
  addStatusBarItem(): FakeElement {
    return fakeContainer();
  }
  registerEvent(): void {}
  registerDomEvent(): void {}
  registerInterval(): void {}
  async loadData(): Promise<unknown> {
    return null;
  }
  async saveData(): Promise<void> {}
}

export class PluginSettingTab {
  containerEl: FakeElement = fakeContainer();
  constructor(
    readonly app: App,
    readonly plugin: unknown
  ) {}
  display(): void {}
  hide(): void {}
}

export class Modal {
  /**
   * Every modal that has been opened, newest last. A window the page raises is part of what
   * the page does — a test that cannot reach it can only assert that a button was wired, not
   * that clicking it asks anything or that answering has an effect.
   */
  static readonly shown: Modal[] = [];
  contentEl: FakeElement = fakeContainer();
  titleEl: FakeElement = fakeContainer();
  opened = false;
  constructor(readonly app: App) {}
  open(): void {
    this.opened = true;
    Modal.shown.push(this);
    (this as unknown as { onOpen?: () => void }).onOpen?.();
  }
  close(): void {
    this.opened = false;
    // Obsidian runs onClose on the way out, and several of this plugin's windows rely on it:
    // a dismissal is a refusal, so a caller awaiting an answer settles instead of hanging.
    (this as unknown as { onClose?: () => void }).onClose?.();
  }
}

export class Notice {
  static readonly shown: string[] = [];
  constructor(readonly message: string) {
    Notice.shown.push(message);
  }
  hide(): void {}
}

export class TFolder {}
export class TFile {}

export const Platform = {
  isMobile: false,
  isDesktop: true,
  // Hotkey labels differ per platform; tests that care pass the flag to the pure formatter.
  isMacOS: false,
  isIosApp: false,
  isAndroidApp: false,
};

export async function requestUrl(): Promise<unknown> {
  throw new Error("requestUrl is not available in the fake obsidian module");
}

export function setIcon(): void {}
