// Minimal stand-in for the `obsidian` module so settings-tab rendering is testable in node.
// Vitest aliases "obsidian" here (see vitest.config.ts). It models only the surface the
// plugin's UI actually touches, and records what was rendered so tests can assert on the
// result rather than on a real DOM.

export type RenderedKind = "text" | "textarea" | "toggle" | "dropdown" | "button" | "extra-button";

export interface RenderedSetting {
  name: string;
  desc: string;
  controls: RenderedKind[];
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
  private readonly listeners = new Map<string, Array<() => void>>();
  addEventListener(event: string, fn: () => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(fn);
    this.listeners.set(event, list);
  }
  /** Test helper: fire a listener the UI registered (blur staging, etc.). */
  fire(event: string): void {
    for (const fn of this.listeners.get(event) ?? []) fn();
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
  constructor(
    readonly tag: string,
    readonly text: string,
    readonly log: RenderLog,
    readonly cls: string = ""
  ) {}
  focus(): void {}
  select(): void {
    this.selected = true;
  }
  setAttr(): void {}
  empty(): void {
    this.children.length = 0;
    this.log.headings.length = 0;
    this.log.paragraphs.length = 0;
    this.log.settings.length = 0;
    this.log.rows.length = 0;
  }
  createEl(tag: string, opts?: { text?: string; cls?: string }): FakeElement {
    const el = new FakeElement(tag, opts?.text ?? "", this.log, opts?.cls ?? "");
    this.children.push(el);
    if (tag === "h3" || tag === "h2") this.log.headings.push(el.text);
    if (tag === "p") this.log.paragraphs.push(el.text);
    return el;
  }
  createDiv(opts?: { text?: string; cls?: string }): FakeElement {
    return this.createEl("div", opts);
  }
  /** Every text in this subtree, in render order. */
  texts(): string[] {
    return this.children.flatMap((c) => [c.text, ...c.texts()]).filter((t) => t !== "");
  }
  /** Elements in this subtree carrying `cls`, for asserting a diff was actually drawn. */
  byClass(cls: string): FakeElement[] {
    return this.children.flatMap((c) => [...(c.cls === cls ? [c] : []), ...c.byClass(cls)]);
  }
  setText(): void {}
  addClass(): void {}
  removeClass(): void {}
  setAttribute(): void {}
}

export function fakeContainer(log = newRenderLog()): FakeElement {
  return new FakeElement("div", "", log);
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
  readonly rendered: RenderedSetting = { name: "", desc: "", controls: [] };
  readonly texts: TextComponent[] = [];
  readonly toggles: ToggleComponent[] = [];
  readonly dropdowns: DropdownComponent[] = [];
  readonly buttons: ButtonComponent[] = [];

  // Registered on construction, so a throw part-way through a chain still shows how far
  // rendering got — that is exactly the failure this fake exists to catch.
  constructor(container: FakeElement) {
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
  setHeading(): this {
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
  contentEl: FakeElement = fakeContainer();
  titleEl: FakeElement = fakeContainer();
  opened = false;
  constructor(readonly app: App) {}
  open(): void {
    this.opened = true;
    (this as unknown as { onOpen?: () => void }).onOpen?.();
  }
  close(): void {
    this.opened = false;
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
