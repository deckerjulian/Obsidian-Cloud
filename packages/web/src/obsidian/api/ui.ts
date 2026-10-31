import { Component, Scope } from './component';
import { setIcon, prepareFuzzySearch, renderMatches, type SearchResult } from './util';
import type { App } from './app';

/**
 * Obsidian UI primitives with Obsidian's DOM/class names (so plugin CSS keeps
 * working): Notice, Modal, Menu, Setting + components, setting tabs, suggest
 * modals/popovers.
 */

// ── Notice ──────────────────────────────────────────────────────────────────
function noticeContainer(): HTMLElement {
  let c = document.body.querySelector<HTMLElement>(':scope > .notice-container');
  if (!c) c = document.body.createDiv({ cls: 'notice-container' });
  return c;
}

export class Notice {
  noticeEl: HTMLElement;
  messageEl: HTMLElement;
  containerEl: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(message: string | DocumentFragment, duration?: number) {
    this.noticeEl = noticeContainer().createDiv({ cls: 'notice' });
    this.containerEl = this.noticeEl;
    this.messageEl = this.noticeEl.createDiv({ cls: 'notice-message' });
    this.setMessage(message);
    this.noticeEl.addEventListener('click', () => this.hide());
    const d = duration ?? 4500;
    if (d > 0) this.timer = setTimeout(() => this.hide(), d);
  }
  setMessage(message: string | DocumentFragment): this {
    this.messageEl.empty();
    if (typeof message === 'string') this.messageEl.setText(message);
    else this.messageEl.appendChild(message);
    return this;
  }
  hide(): void {
    if (this.timer) clearTimeout(this.timer);
    this.noticeEl.remove();
  }
}

// ── Modal ───────────────────────────────────────────────────────────────────
export class Modal {
  scope: Scope;
  containerEl: HTMLElement;
  modalEl: HTMLElement;
  titleEl: HTMLElement;
  contentEl: HTMLElement;
  headerEl: HTMLElement;
  shouldRestoreSelection = false;
  private closeCb: (() => unknown) | null = null;
  private keyHandler = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      this.close();
      return;
    }
    this.scope.handleKey(ev);
  };
  constructor(public app: App) {
    this.scope = new Scope();
    this.containerEl = createDiv({ cls: 'modal-container mod-dim' });
    const bg = this.containerEl.createDiv({ cls: 'modal-bg' });
    bg.addEventListener('click', () => this.close());
    this.modalEl = this.containerEl.createDiv({ cls: 'modal' });
    const close = this.modalEl.createDiv({ cls: 'modal-close-button' });
    setIcon(close, 'x');
    close.addEventListener('click', () => this.close());
    this.headerEl = this.modalEl.createDiv({ cls: 'modal-header' });
    this.titleEl = this.headerEl.createDiv({ cls: 'modal-title' });
    this.contentEl = this.modalEl.createDiv({ cls: 'modal-content' });
  }
  open(): void {
    document.body.appendChild(this.containerEl);
    document.addEventListener('keydown', this.keyHandler, true);
    const r = this.onOpen() as unknown;
    if (r instanceof Promise) r.catch((e) => console.error(e));
  }
  close(): void {
    if (!this.containerEl.isConnected) return;
    document.removeEventListener('keydown', this.keyHandler, true);
    this.containerEl.remove();
    this.onClose();
    this.closeCb?.();
  }
  onOpen(): void | Promise<void> {}
  onClose(): void {}
  setTitle(title: string | DocumentFragment): this {
    this.titleEl.empty();
    if (typeof title === 'string') this.titleEl.setText(title);
    else this.titleEl.appendChild(title);
    return this;
  }
  setContent(content: string | DocumentFragment): this {
    this.contentEl.empty();
    if (typeof content === 'string') this.contentEl.setText(content);
    else this.contentEl.appendChild(content);
    return this;
  }
  setCloseCallback(cb: () => unknown): this {
    this.closeCb = cb;
    return this;
  }
}

/** Newer API: a modal with a footer of buttons / an acknowledgement checkbox. */
export class ConfirmationModal extends Modal {
  buttonContainerEl: HTMLElement;
  constructor(app: App) {
    super(app);
    this.buttonContainerEl = this.modalEl.createDiv({ cls: 'modal-button-container' });
  }
  addButton(cb: (btn: ButtonComponent) => unknown): this {
    cb(new ButtonComponent(this.buttonContainerEl));
    return this;
  }
  addCancelButton(cb?: () => unknown): this {
    return this.addButton((b) =>
      b.setButtonText('Cancel').onClick(() => {
        cb?.();
        this.close();
      }),
    );
  }
  addCheckbox(label: string, cb?: (checked: boolean) => unknown): this {
    const wrap = this.buttonContainerEl.createEl('label', { cls: 'mod-checkbox' });
    const input = wrap.createEl('input', { type: 'checkbox' });
    wrap.appendText(` ${label}`);
    input.addEventListener('change', () => cb?.(input.checked));
    return this;
  }
}

// ── Menu ────────────────────────────────────────────────────────────────────
export class MenuItem {
  dom: HTMLElement;
  iconEl: HTMLElement;
  titleEl: HTMLElement;
  private handler: ((evt: MouseEvent | KeyboardEvent) => unknown) | null = null;
  section = '';
  submenu: Menu | null = null;
  constructor(private readonly menu: Menu) {
    this.dom = createDiv({ cls: 'menu-item' });
    this.iconEl = this.dom.createDiv({ cls: 'menu-item-icon' });
    this.titleEl = this.dom.createDiv({ cls: 'menu-item-title' });
    this.dom.addEventListener('click', (ev) => {
      if (this.dom.hasClass('is-disabled')) return;
      if (this.submenu) {
        const r = this.dom.getBoundingClientRect();
        this.submenu.showAtPosition({ x: r.right, y: r.top });
        return;
      }
      this.menu.hide();
      this.handler?.(ev);
    });
  }
  setTitle(title: string | DocumentFragment): this {
    this.titleEl.empty();
    if (typeof title === 'string') this.titleEl.setText(title);
    else this.titleEl.appendChild(title);
    return this;
  }
  setIcon(icon: string | null): this {
    if (icon) setIcon(this.iconEl, icon);
    else this.iconEl.empty();
    return this;
  }
  setChecked(checked: boolean | null): this {
    this.dom.toggleClass('mod-checked', !!checked);
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.dom.toggleClass('is-disabled', disabled);
    return this;
  }
  setWarning(w: boolean): this {
    this.dom.toggleClass('is-warning', w);
    return this;
  }
  setIsLabel(l: boolean): this {
    this.dom.toggleClass('is-label', l);
    return this;
  }
  setSection(section: string): this {
    this.section = section;
    return this;
  }
  setSubmenu(): Menu {
    this.submenu = new Menu();
    return this.submenu;
  }
  onClick(cb: (evt: MouseEvent | KeyboardEvent) => unknown): this {
    this.handler = cb;
    return this;
  }
}

export class Menu extends Component {
  dom: HTMLElement;
  items: Array<MenuItem | 'separator'> = [];
  private hideCbs: Array<() => unknown> = [];
  private outside = (ev: MouseEvent): void => {
    if (!this.dom.contains(ev.target as Node)) this.hide();
  };
  constructor() {
    super();
    this.dom = createDiv({ cls: 'menu' });
  }
  setNoIcon(): this {
    this.dom.addClass('mod-no-icon');
    return this;
  }
  setUseNativeMenu(_v: boolean): this {
    return this;
  }
  addItem(cb: (item: MenuItem) => unknown): this {
    const item = new MenuItem(this);
    cb(item);
    this.items.push(item);
    return this;
  }
  addSeparator(): this {
    this.items.push('separator');
    return this;
  }
  showAtMouseEvent(evt: MouseEvent): this {
    evt.preventDefault();
    return this.showAtPosition({ x: evt.clientX, y: evt.clientY });
  }
  showAtPosition(pos: { x: number; y: number }): this {
    this.dom.empty();
    for (const it of this.items) {
      if (it === 'separator') this.dom.createDiv({ cls: 'menu-separator' });
      else this.dom.appendChild(it.dom);
    }
    this.dom.style.position = 'fixed';
    this.dom.style.left = `${pos.x}px`;
    this.dom.style.top = `${pos.y}px`;
    this.dom.style.zIndex = '1000';
    document.body.appendChild(this.dom);
    setTimeout(() => document.addEventListener('mousedown', this.outside, true));
    this.load();
    return this;
  }
  hide(): void {
    if (!this.dom.isConnected) return;
    document.removeEventListener('mousedown', this.outside, true);
    this.dom.remove();
    this.unload();
    for (const cb of this.hideCbs) cb();
  }
  close(): void {
    this.hide();
  }
  onHide(cb: () => unknown): void {
    this.hideCbs.push(cb);
  }
  static forEvent(evt: MouseEvent): Menu {
    const m = new Menu();
    const orig = m.showAtPosition.bind(m);
    queueMicrotask(() => {
      if (!m.dom.isConnected && m.items.length) orig({ x: evt.clientX, y: evt.clientY });
    });
    return m;
  }
}

// ── setting components ──────────────────────────────────────────────────────
export class BaseComponent {
  disabled = false;
  then(cb: (component: this) => unknown): this {
    cb(this);
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }
}

export class ValueComponent<T> extends BaseComponent {
  registerOptionListener(listeners: Record<string, (value?: T) => T>, key: string): this {
    listeners[key] = (value?: T) => {
      if (value !== undefined) this.setValue(value);
      return this.getValue();
    };
    return this;
  }
  getValue(): T {
    return undefined as T;
  }
  setValue(_value: T): this {
    return this;
  }
}

export class ButtonComponent extends BaseComponent {
  buttonEl: HTMLButtonElement;
  constructor(containerEl: HTMLElement) {
    super();
    this.buttonEl = containerEl.createEl('button');
  }
  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.buttonEl.disabled = disabled;
    return this;
  }
  setCta(): this {
    this.buttonEl.addClass('mod-cta');
    return this;
  }
  removeCta(): this {
    this.buttonEl.removeClass('mod-cta');
    return this;
  }
  setWarning(): this {
    this.buttonEl.addClass('mod-warning');
    return this;
  }
  setTooltip(tooltip: string): this {
    this.buttonEl.setAttribute('aria-label', tooltip);
    this.buttonEl.title = tooltip;
    return this;
  }
  setButtonText(name: string): this {
    this.buttonEl.setText(name);
    return this;
  }
  setIcon(icon: string): this {
    setIcon(this.buttonEl, icon);
    return this;
  }
  setClass(cls: string): this {
    this.buttonEl.addClass(cls);
    return this;
  }
  onClick(cb: (evt: MouseEvent) => unknown): this {
    this.buttonEl.addEventListener('click', (ev) => cb(ev));
    return this;
  }
}

export class ExtraButtonComponent extends BaseComponent {
  extraSettingsEl: HTMLElement;
  constructor(containerEl: HTMLElement) {
    super();
    this.extraSettingsEl = containerEl.createDiv({ cls: 'clickable-icon extra-setting-button' });
  }
  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.extraSettingsEl.toggleClass('is-disabled', disabled);
    return this;
  }
  setTooltip(tooltip: string): this {
    this.extraSettingsEl.setAttribute('aria-label', tooltip);
    this.extraSettingsEl.title = tooltip;
    return this;
  }
  setIcon(icon: string): this {
    setIcon(this.extraSettingsEl, icon);
    return this;
  }
  onClick(cb: () => unknown): this {
    this.extraSettingsEl.addEventListener('click', () => !this.disabled && cb());
    return this;
  }
}

export class ToggleComponent extends ValueComponent<boolean> {
  toggleEl: HTMLElement;
  private value = false;
  private changeCb: ((v: boolean) => unknown) | null = null;
  constructor(containerEl: HTMLElement) {
    super();
    this.toggleEl = containerEl.createDiv({ cls: 'checkbox-container' });
    this.toggleEl.createEl('input', { type: 'checkbox' });
    this.toggleEl.addEventListener('click', () => this.onClick());
  }
  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.toggleEl.toggleClass('is-disabled', disabled);
    return this;
  }
  override getValue(): boolean {
    return this.value;
  }
  override setValue(on: boolean): this {
    this.value = on;
    this.toggleEl.toggleClass('is-enabled', on);
    const input = this.toggleEl.querySelector('input');
    if (input) input.checked = on;
    return this;
  }
  setTooltip(tooltip: string): this {
    this.toggleEl.title = tooltip;
    return this;
  }
  onClick(): void {
    if (this.disabled) return;
    this.setValue(!this.value);
    this.changeCb?.(this.value);
  }
  onChange(cb: (value: boolean) => unknown): this {
    this.changeCb = cb;
    return this;
  }
}

export class AbstractTextComponent<T extends HTMLInputElement | HTMLTextAreaElement> extends ValueComponent<string> {
  private changeCb: ((v: string) => unknown) | null = null;
  constructor(public inputEl: T) {
    super();
    inputEl.addEventListener('input', () => this.onChanged());
  }
  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.inputEl.disabled = disabled;
    return this;
  }
  override getValue(): string {
    return this.inputEl.value;
  }
  override setValue(value: string): this {
    this.inputEl.value = value ?? '';
    return this;
  }
  setPlaceholder(placeholder: string): this {
    this.inputEl.placeholder = placeholder;
    return this;
  }
  onChanged(): void {
    this.changeCb?.(this.getValue());
  }
  onChange(cb: (value: string) => unknown): this {
    this.changeCb = cb;
    return this;
  }
}

export class TextComponent extends AbstractTextComponent<HTMLInputElement> {
  constructor(containerEl: HTMLElement) {
    super(containerEl.createEl('input', { type: 'text' }));
  }
}
export class SearchComponent extends AbstractTextComponent<HTMLInputElement> {
  clearButtonEl: HTMLElement;
  containerEl: HTMLElement;
  constructor(containerEl: HTMLElement) {
    const wrap = containerEl.createDiv({ cls: 'search-input-container' });
    super(wrap.createEl('input', { type: 'search' }));
    this.containerEl = wrap;
    this.clearButtonEl = wrap.createDiv({ cls: 'search-input-clear-button' });
    this.clearButtonEl.addEventListener('click', () => {
      this.setValue('');
      this.onChanged();
    });
  }
  setClass(cls: string): this {
    this.containerEl.addClass(cls);
    return this;
  }
}
export class TextAreaComponent extends AbstractTextComponent<HTMLTextAreaElement> {
  constructor(containerEl: HTMLElement) {
    super(containerEl.createEl('textarea'));
  }
}
export class MomentFormatComponent extends TextComponent {
  sampleEl: HTMLElement | null = null;
  private defaultFormat = '';
  setDefaultFormat(f: string): this {
    this.defaultFormat = f;
    this.setPlaceholder(f);
    return this;
  }
  setSampleEl(el: HTMLElement): this {
    this.sampleEl = el;
    this.updateSample();
    return this;
  }
  override setValue(value: string): this {
    super.setValue(value);
    this.updateSample();
    return this;
  }
  override onChanged(): void {
    super.onChanged();
    this.updateSample();
  }
  updateSample(): void {
    if (!this.sampleEl) return;
    const m = (window as unknown as { moment?: (d?: unknown) => { format(f: string): string } }).moment;
    const f = this.getValue() || this.defaultFormat;
    this.sampleEl.setText(m ? m().format(f) : f);
  }
}

export class DropdownComponent extends ValueComponent<string> {
  selectEl: HTMLSelectElement;
  private changeCb: ((v: string) => unknown) | null = null;
  constructor(containerEl: HTMLElement) {
    super();
    this.selectEl = containerEl.createEl('select', { cls: 'dropdown' });
    this.selectEl.addEventListener('change', () => this.changeCb?.(this.getValue()));
  }
  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.selectEl.disabled = disabled;
    return this;
  }
  addOption(value: string, display: string): this {
    this.selectEl.createEl('option', { text: display, value });
    return this;
  }
  addOptions(options: Record<string, string>): this {
    for (const [v, d] of Object.entries(options)) this.addOption(v, d);
    return this;
  }
  override getValue(): string {
    return this.selectEl.value;
  }
  override setValue(value: string): this {
    this.selectEl.value = value;
    return this;
  }
  onChange(cb: (value: string) => unknown): this {
    this.changeCb = cb;
    return this;
  }
}

export class SliderComponent extends ValueComponent<number> {
  sliderEl: HTMLInputElement;
  private changeCb: ((v: number) => unknown) | null = null;
  constructor(containerEl: HTMLElement) {
    super();
    this.sliderEl = containerEl.createEl('input', { type: 'range', cls: 'slider' });
    this.sliderEl.addEventListener('input', () => this.changeCb?.(this.getValue()));
  }
  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.sliderEl.disabled = disabled;
    return this;
  }
  setInstant(_instant: boolean): this {
    return this;
  }
  setLimits(min: number | null, max: number | null, step: number | 'any'): this {
    if (min !== null) this.sliderEl.min = String(min);
    if (max !== null) this.sliderEl.max = String(max);
    this.sliderEl.step = String(step);
    return this;
  }
  getValuePretty(): string {
    return String(this.getValue());
  }
  setDynamicTooltip(): this {
    this.sliderEl.addEventListener('input', () => (this.sliderEl.title = this.getValuePretty()));
    return this;
  }
  showTooltip(): void {}
  override getValue(): number {
    return Number(this.sliderEl.value);
  }
  override setValue(value: number): this {
    this.sliderEl.value = String(value);
    return this;
  }
  onChange(cb: (value: number) => unknown): this {
    this.changeCb = cb;
    return this;
  }
}

export class ColorComponent extends ValueComponent<string> {
  colorPickerEl: HTMLInputElement;
  private changeCb: ((v: string) => unknown) | null = null;
  constructor(containerEl: HTMLElement) {
    super();
    this.colorPickerEl = containerEl.createEl('input', { type: 'color' });
    this.colorPickerEl.addEventListener('input', () => this.changeCb?.(this.getValue()));
  }
  override getValue(): string {
    return this.colorPickerEl.value;
  }
  override setValue(value: string): this {
    this.colorPickerEl.value = value;
    return this;
  }
  getValueRgb(): { r: number; g: number; b: number } {
    const v = this.getValue().replace('#', '');
    return { r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2, 4), 16), b: parseInt(v.slice(4, 6), 16) };
  }
  getValueHsl(): { h: number; s: number; l: number } {
    return { h: 0, s: 0, l: 0 };
  }
  setValueRgb(rgb: { r: number; g: number; b: number }): this {
    const h = (n: number): string => n.toString(16).padStart(2, '0');
    return this.setValue(`#${h(rgb.r)}${h(rgb.g)}${h(rgb.b)}`);
  }
  setValueHsl(): this {
    return this;
  }
  onChange(cb: (value: string) => unknown): this {
    this.changeCb = cb;
    return this;
  }
}

export class ProgressBarComponent extends ValueComponent<number> {
  progressBar: HTMLElement;
  private value = 0;
  constructor(containerEl: HTMLElement) {
    super();
    this.progressBar = containerEl.createDiv({ cls: 'setting-progress-bar' });
    this.progressBar.createDiv({ cls: 'setting-progress-bar-inner' });
  }
  override getValue(): number {
    return this.value;
  }
  override setValue(value: number): this {
    this.value = value;
    (this.progressBar.firstElementChild as HTMLElement).style.width = `${value}%`;
    return this;
  }
}

// ── Setting ─────────────────────────────────────────────────────────────────
export class Setting {
  settingEl: HTMLElement;
  infoEl: HTMLElement;
  nameEl: HTMLElement;
  descEl: HTMLElement;
  controlEl: HTMLElement;
  components: BaseComponent[] = [];
  constructor(containerEl: HTMLElement) {
    this.settingEl = containerEl.createDiv({ cls: 'setting-item' });
    this.infoEl = this.settingEl.createDiv({ cls: 'setting-item-info' });
    this.nameEl = this.infoEl.createDiv({ cls: 'setting-item-name' });
    this.descEl = this.infoEl.createDiv({ cls: 'setting-item-description' });
    this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' });
  }
  setName(name: string | DocumentFragment): this {
    this.nameEl.empty();
    if (typeof name === 'string') this.nameEl.setText(name);
    else this.nameEl.appendChild(name);
    return this;
  }
  setDesc(desc: string | DocumentFragment): this {
    this.descEl.empty();
    if (typeof desc === 'string') this.descEl.setText(desc);
    else this.descEl.appendChild(desc);
    return this;
  }
  setClass(cls: string): this {
    this.settingEl.addClass(cls);
    return this;
  }
  setTooltip(tooltip: string): this {
    this.nameEl.title = tooltip;
    return this;
  }
  setHeading(): this {
    this.settingEl.addClass('setting-item-heading');
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.settingEl.toggleClass('is-disabled', disabled);
    for (const c of this.components) c.setDisabled(disabled);
    return this;
  }
  private add<C extends BaseComponent>(c: C, cb: (c: C) => unknown): this {
    this.components.push(c);
    cb(c);
    return this;
  }
  addButton(cb: (c: ButtonComponent) => unknown): this {
    return this.add(new ButtonComponent(this.controlEl), cb);
  }
  addExtraButton(cb: (c: ExtraButtonComponent) => unknown): this {
    return this.add(new ExtraButtonComponent(this.controlEl), cb);
  }
  addToggle(cb: (c: ToggleComponent) => unknown): this {
    return this.add(new ToggleComponent(this.controlEl), cb);
  }
  addText(cb: (c: TextComponent) => unknown): this {
    return this.add(new TextComponent(this.controlEl), cb);
  }
  addSearch(cb: (c: SearchComponent) => unknown): this {
    return this.add(new SearchComponent(this.controlEl), cb);
  }
  addTextArea(cb: (c: TextAreaComponent) => unknown): this {
    return this.add(new TextAreaComponent(this.controlEl), cb);
  }
  addMomentFormat(cb: (c: MomentFormatComponent) => unknown): this {
    return this.add(new MomentFormatComponent(this.controlEl), cb);
  }
  addDropdown(cb: (c: DropdownComponent) => unknown): this {
    return this.add(new DropdownComponent(this.controlEl), cb);
  }
  addColorPicker(cb: (c: ColorComponent) => unknown): this {
    return this.add(new ColorComponent(this.controlEl), cb);
  }
  addProgressBar(cb: (c: ProgressBarComponent) => unknown): this {
    return this.add(new ProgressBarComponent(this.controlEl), cb);
  }
  addSlider(cb: (c: SliderComponent) => unknown): this {
    return this.add(new SliderComponent(this.controlEl), cb);
  }
  addComponent<C extends BaseComponent>(cb: (el: HTMLElement) => C): this {
    this.components.push(cb(this.controlEl));
    return this;
  }
  then(cb: (setting: this) => unknown): this {
    cb(this);
    return this;
  }
  clear(): this {
    this.controlEl.empty();
    this.components = [];
    return this;
  }
}

/** Newer API: a titled group of settings. */
export class SettingGroup {
  groupEl: HTMLElement;
  headerEl: HTMLElement;
  listEl: HTMLElement;
  constructor(containerEl: HTMLElement) {
    this.groupEl = containerEl.createDiv({ cls: 'setting-group' });
    this.headerEl = this.groupEl.createDiv({ cls: 'setting-group-heading' });
    this.listEl = this.groupEl.createDiv({ cls: 'setting-items' });
  }
  setHeading(text: string | DocumentFragment): this {
    this.headerEl.empty();
    if (typeof text === 'string') this.headerEl.setText(text);
    else this.headerEl.appendChild(text);
    return this;
  }
  addClass(cls: string): this {
    this.groupEl.addClass(cls);
    return this;
  }
  addSetting(cb: (setting: Setting) => unknown): this {
    cb(new Setting(this.listEl));
    return this;
  }
  addSearch(cb: (c: SearchComponent) => unknown): this {
    cb(new SearchComponent(this.headerEl));
    return this;
  }
  addExtraButton(cb: (c: ExtraButtonComponent) => unknown): this {
    cb(new ExtraButtonComponent(this.headerEl));
    return this;
  }
}

export abstract class SettingTab {
  app!: App;
  containerEl: HTMLElement;
  icon = '';
  constructor() {
    this.containerEl = createDiv({ cls: 'vertical-tab-content' });
  }
  abstract display(): void;
  hide(): void {
    this.containerEl.empty();
  }
}

/** One entry of the declarative settings API (Obsidian 1.10+; Templater uses it). */
interface SettingDef {
  type?: string;
  name?: string | DocumentFragment;
  desc?: string | DocumentFragment;
  heading?: string;
  cls?: string;
  items?: SettingDef[];
  visible?: () => boolean;
  control?: { type: string; key: string; options?: Record<string, string>; placeholder?: string };
  page?: () => SettingPage;
  addItem?: { name: string; action: () => unknown };
  onDelete?: (index: number) => unknown;
  emptyState?: string;
  actions?: Array<{ icon: string; tooltip?: string; action: () => unknown }>;
}
type DeclarativeTab = {
  getSettingDefinitions?: () => SettingDef[];
  getControlValue?: (key: string) => unknown;
  setControlValue?: (key: string, value: unknown) => unknown;
};

export class PluginSettingTab extends SettingTab {
  private subPage: SettingDef | null = null;
  constructor(
    app: App,
    public plugin: unknown,
  ) {
    super();
    this.app = app;
  }
  /** Default display(): renders `getSettingDefinitions()` for plugins using
   *  the declarative API; classic plugins override display() entirely. */
  display(): void {
    const self = this as unknown as DeclarativeTab;
    if (typeof self.getSettingDefinitions !== 'function') return;
    this.containerEl.empty();
    if (this.subPage) {
      const page = this.subPage;
      const back = new Setting(this.containerEl).setHeading().setName(page.name ?? '');
      back.addExtraButton((b) =>
        b.setIcon('arrow-left').setTooltip('Back').onClick(() => {
          this.subPage = null;
          this.display();
        }),
      );
      if (page.page) {
        const p = page.page();
        this.containerEl.appendChild(p.containerEl);
        p.display();
      }
      this.renderDefs(page.items ?? [], this.containerEl, self);
      return;
    }
    this.renderDefs(self.getSettingDefinitions(), this.containerEl, self);
  }
  private renderDefs(defs: SettingDef[], el: HTMLElement, self: DeclarativeTab): void {
    for (const d of defs) {
      if (!d || (d.visible && !d.visible())) continue;
      if (d.type === 'group') {
        const g = new SettingGroup(el);
        if (d.heading ?? d.name) g.setHeading((d.heading ?? d.name)!);
        if (d.cls) g.addClass(d.cls);
        this.renderDefs(d.items ?? [], g.listEl, self);
        continue;
      }
      if (d.type === 'page') {
        const s = new Setting(el);
        if (d.name) s.setName(d.name);
        if (d.desc) s.setDesc(d.desc);
        s.addExtraButton((b) =>
          b.setIcon('chevron-right').onClick(() => {
            this.subPage = d;
            this.display();
          }),
        );
        continue;
      }
      if (d.type === 'list') {
        if (!d.items?.length && d.emptyState) el.createDiv({ cls: 'setting-item mod-empty-state', text: d.emptyState });
        (d.items ?? []).forEach((item, i) => {
          const s = new Setting(el);
          if (item.name) s.setName(item.name);
          if (item.desc) s.setDesc(item.desc);
          for (const a of item.actions ?? []) {
            s.addExtraButton((b) => b.setIcon(a.icon).setTooltip(a.tooltip ?? '').onClick(() => a.action()));
          }
          if (d.onDelete) s.addExtraButton((b) => b.setIcon('x').setTooltip('Delete').onClick(() => d.onDelete!(i)));
        });
        if (d.addItem) new Setting(el).addButton((b) => b.setButtonText(d.addItem!.name).onClick(() => d.addItem!.action()));
        continue;
      }
      const s = new Setting(el);
      if (d.name) s.setName(d.name);
      if (d.desc) s.setDesc(d.desc);
      if (d.cls) s.setClass(d.cls);
      if (d.items) this.renderDefs(d.items, el, self);
      const c = d.control;
      if (!c) continue;
      const get = (): unknown => self.getControlValue?.(c.key);
      const set = (v: unknown): void => void Promise.resolve(self.setControlValue?.(c.key, v)).catch((e) => console.error(e));
      if (c.type === 'toggle') s.addToggle((t) => t.setValue(!!get()).onChange(set));
      else if (c.type === 'dropdown') s.addDropdown((dd) => dd.addOptions(c.options ?? {}).setValue(String(get() ?? '')).onChange(set));
      else if (c.type === 'number') {
        s.addText((t) => {
          t.inputEl.type = 'number';
          t.setValue(String(get() ?? '')).onChange((v) => set(Number(v)));
        });
      } else s.addText((t) => t.setPlaceholder(c.placeholder ?? '').setValue(String(get() ?? '')).onChange(set));
    }
  }
  /** Re-render (the declarative API calls this after value changes). */
  update(): void {
    if (this.containerEl.isConnected) this.display();
  }
}

/** Newer API: a sub-page inside a setting tab. */
export class SettingPage {
  containerEl: HTMLElement;
  constructor() {
    this.containerEl = createDiv({ cls: 'setting-page' });
  }
  display(): void {}
  hide(): void {
    this.containerEl.empty();
  }
}

// ── suggest UIs ─────────────────────────────────────────────────────────────
interface Instruction {
  command: string;
  purpose: string;
}

/** Shared keyboard-navigable suggestion list. */
class SuggestList<T> {
  values: T[] = [];
  selected = 0;
  els: HTMLElement[] = [];
  constructor(
    readonly containerEl: HTMLElement,
    private readonly render: (v: T, el: HTMLElement) => void,
    private readonly choose: (v: T, evt: MouseEvent | KeyboardEvent) => void,
  ) {}
  set(values: T[]): void {
    this.values = values;
    this.containerEl.empty();
    this.els = values.map((v, i) => {
      const el = this.containerEl.createDiv({ cls: 'suggestion-item' });
      this.render(v, el);
      el.addEventListener('mousemove', () => this.select(i));
      el.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        this.choose(v, ev);
      });
      return el;
    });
    this.select(0);
  }
  select(i: number): void {
    if (!this.els.length) return;
    this.selected = (i + this.els.length) % this.els.length;
    this.els.forEach((el, k) => el.toggleClass('is-selected', k === this.selected));
    this.els[this.selected].scrollIntoView?.({ block: 'nearest' });
  }
  key(ev: KeyboardEvent): boolean {
    if (ev.key === 'ArrowDown') this.select(this.selected + 1);
    else if (ev.key === 'ArrowUp') this.select(this.selected - 1);
    else if (ev.key === 'Enter' || ev.key === 'Tab') {
      const v = this.values[this.selected];
      if (v === undefined) return false;
      this.choose(v, ev);
    } else return false;
    ev.preventDefault();
    return true;
  }
}

export abstract class SuggestModal<T> extends Modal {
  limit = 100;
  emptyStateText = 'No results found.';
  inputEl: HTMLInputElement;
  resultContainerEl: HTMLElement;
  private list: SuggestList<T>;
  private instructionsEl: HTMLElement;
  constructor(app: App) {
    super(app);
    this.modalEl.addClass('prompt');
    this.inputEl = this.contentEl.createEl('input', { cls: 'prompt-input', type: 'text' });
    this.resultContainerEl = this.contentEl.createDiv({ cls: 'prompt-results' });
    this.instructionsEl = this.contentEl.createDiv({ cls: 'prompt-instructions' });
    this.list = new SuggestList<T>(
      this.resultContainerEl,
      (v, el) => this.renderSuggestion(v, el),
      (v, evt) => {
        this.close();
        this.selectSuggestion(v, evt);
      },
    );
    this.inputEl.addEventListener('input', () => void this.updateSuggestions());
    this.inputEl.addEventListener('keydown', (ev) => this.list.key(ev));
  }
  setPlaceholder(placeholder: string): void {
    this.inputEl.placeholder = placeholder;
  }
  setInstructions(instructions: Instruction[]): void {
    this.instructionsEl.empty();
    for (const i of instructions) {
      const row = this.instructionsEl.createDiv({ cls: 'prompt-instruction' });
      row.createSpan({ cls: 'prompt-instruction-command', text: i.command });
      row.createSpan({ text: i.purpose });
    }
  }
  override onOpen(): void {
    void this.updateSuggestions();
    setTimeout(() => this.inputEl.focus());
  }
  async updateSuggestions(): Promise<void> {
    const vals = (await this.getSuggestions(this.inputEl.value)).slice(0, this.limit);
    this.list.set(vals);
    if (!vals.length) this.resultContainerEl.createDiv({ cls: 'suggestion-empty', text: this.emptyStateText });
  }
  selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void {
    this.onChooseSuggestion(value, evt);
  }
  abstract getSuggestions(query: string): T[] | Promise<T[]>;
  abstract renderSuggestion(value: T, el: HTMLElement): void;
  abstract onChooseSuggestion(item: T, evt: MouseEvent | KeyboardEvent): void;
}

export interface FuzzyMatch<T> {
  item: T;
  match: SearchResult;
}

export abstract class FuzzySuggestModal<T> extends SuggestModal<FuzzyMatch<T>> {
  getSuggestions(query: string): FuzzyMatch<T>[] {
    const search = prepareFuzzySearch(query);
    const out: FuzzyMatch<T>[] = [];
    for (const item of this.getItems()) {
      const match = search(this.getItemText(item));
      if (match) out.push({ item, match });
    }
    if (query) out.sort((a, b) => b.match.score - a.match.score);
    return out;
  }
  renderSuggestion(value: FuzzyMatch<T>, el: HTMLElement): void {
    renderMatches(el, this.getItemText(value.item), value.match.matches);
  }
  onChooseSuggestion(item: FuzzyMatch<T>, evt: MouseEvent | KeyboardEvent): void {
    this.onChooseItem(item.item, evt);
  }
  abstract getItems(): T[];
  abstract getItemText(item: T): string;
  abstract onChooseItem(item: T, evt: MouseEvent | KeyboardEvent): void;
}

/** A floating suggestion list (base of AbstractInputSuggest / EditorSuggest). */
export abstract class PopoverSuggest<T> {
  scope = new Scope();
  suggestEl: HTMLElement;
  protected list: SuggestList<T>;
  isOpen = false;
  limit = 100;
  constructor(public app: App) {
    this.suggestEl = createDiv({ cls: 'suggestion-container' });
    const inner = this.suggestEl.createDiv({ cls: 'suggestion' });
    this.list = new SuggestList<T>(
      inner,
      (v, el) => this.renderSuggestion(v, el),
      (v, evt) => this.selectSuggestion(v, evt),
    );
  }
  open(): void {
    if (!this.suggestEl.isConnected) document.body.appendChild(this.suggestEl);
    this.isOpen = true;
  }
  close(): void {
    this.suggestEl.remove();
    this.isOpen = false;
  }
  protected place(rect: { left: number; bottom: number }): void {
    Object.assign(this.suggestEl.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.bottom}px`, zIndex: '1000' });
  }
  abstract renderSuggestion(value: T, el: HTMLElement): void;
  abstract selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void;
}

export abstract class AbstractInputSuggest<T> extends PopoverSuggest<T> {
  private selectCb: ((value: T, evt: MouseEvent | KeyboardEvent) => unknown) | null = null;
  constructor(
    app: App,
    protected textInputEl: HTMLInputElement | HTMLDivElement,
  ) {
    super(app);
    textInputEl.addEventListener('input', () => void this.refresh());
    textInputEl.addEventListener('focus', () => void this.refresh());
    textInputEl.addEventListener('blur', () => setTimeout(() => this.close(), 150));
    textInputEl.addEventListener('keydown', (ev) => {
      if (this.isOpen && this.list.key(ev as KeyboardEvent)) ev.stopPropagation();
      if ((ev as KeyboardEvent).key === 'Escape') this.close();
    });
  }
  getValue(): string {
    return this.textInputEl instanceof HTMLInputElement ? this.textInputEl.value : this.textInputEl.textContent ?? '';
  }
  setValue(value: string): void {
    if (this.textInputEl instanceof HTMLInputElement) this.textInputEl.value = value;
    else this.textInputEl.textContent = value;
  }
  private async refresh(): Promise<void> {
    const vals = (await this.getSuggestions(this.getValue())).slice(0, this.limit);
    if (!vals.length) {
      this.close();
      return;
    }
    this.list.set(vals);
    this.place(this.textInputEl.getBoundingClientRect());
    this.open();
  }
  onSelect(cb: (value: T, evt: MouseEvent | KeyboardEvent) => unknown): this {
    this.selectCb = cb;
    return this;
  }
  selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void {
    this.selectCb?.(value, evt);
    this.close();
  }
  protected abstract getSuggestions(query: string): T[] | Promise<T[]>;
}

export interface EditorPosition {
  line: number;
  ch: number;
}
export interface EditorSuggestContext {
  start: EditorPosition;
  end: EditorPosition;
  query: string;
  editor: any;
  file: any;
}

export abstract class EditorSuggest<T> extends PopoverSuggest<T> {
  context: EditorSuggestContext | null = null;
  override limit = 100;
  private instructions: Instruction[] = [];
  setInstructions(instructions: Instruction[]): void {
    this.instructions = instructions;
  }
  /** Called by the host on editor changes (see PluginHost.notifyEditorChange). */
  async trigger(editor: any, file: any): Promise<void> {
    const cursor = editor.getCursor();
    const info = this.onTrigger(cursor, editor, file);
    if (!info) {
      this.close();
      return;
    }
    this.context = { ...info, editor, file };
    const vals = (await this.getSuggestions(this.context)).slice(0, this.limit);
    if (!vals.length) {
      this.close();
      return;
    }
    this.list.set(vals);
    const cm = editor.cm as { coordsAtPos?(pos: number): { left: number; bottom: number } | null } | undefined;
    const coords = cm?.coordsAtPos?.(editor.posToOffset(cursor));
    if (coords) this.place(coords);
    this.open();
    void this.instructions;
  }
  /** Keyboard handling while open (the host forwards editor keydowns). */
  handleKey(ev: KeyboardEvent): boolean {
    if (!this.isOpen) return false;
    if (ev.key === 'Escape') {
      this.close();
      return true;
    }
    return this.list.key(ev);
  }
  abstract onTrigger(cursor: EditorPosition, editor: any, file: any): { start: EditorPosition; end: EditorPosition; query: string } | null;
  abstract getSuggestions(context: EditorSuggestContext): T[] | Promise<T[]>;
}

export class HoverPopover extends Component {
  hoverEl: HTMLElement;
  constructor(_parent: unknown, _targetEl: HTMLElement | null, _waitTime?: number) {
    super();
    this.hoverEl = createDiv({ cls: 'popover hover-popover' });
  }
}
