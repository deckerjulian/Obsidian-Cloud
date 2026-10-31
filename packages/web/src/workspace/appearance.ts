import type { VaultStore } from '../vault/VaultStore';

/**
 * Apply the vault's `.obsidian/appearance.json` like Obsidian does: base
 * theme (moonstone = light, obsidian = dark, system), fonts, font size, the
 * selected community theme (`themes/<name>/theme.css`) and enabled CSS
 * snippets. A per-device override (light/dark toggle) wins over the vault.
 */
interface Appearance {
  theme?: 'moonstone' | 'obsidian' | 'system';
  cssTheme?: string;
  baseFontSize?: number;
  interfaceFontFamily?: string;
  textFontFamily?: string;
  monospaceFontFamily?: string;
  enabledCssSnippets?: string[];
  accentColor?: string;
}

const OVERRIDE_KEY = 'oc.themeOverride';
export type ThemeChoice = 'light' | 'dark' | 'vault';

export function getThemeOverride(): ThemeChoice {
  const v = localStorage.getItem(OVERRIDE_KEY);
  return v === 'light' || v === 'dark' ? v : 'vault';
}
export function setThemeOverride(v: ThemeChoice): void {
  if (v === 'vault') localStorage.removeItem(OVERRIDE_KEY);
  else localStorage.setItem(OVERRIDE_KEY, v);
}

let vaultTheme: 'light' | 'dark' | 'system' = 'system';

export function applyBaseTheme(): void {
  const o = getThemeOverride();
  const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = o === 'dark' || (o === 'vault' && (vaultTheme === 'dark' || (vaultTheme === 'system' && sysDark)));
  document.body.classList.toggle('theme-dark', dark);
  document.body.classList.toggle('theme-light', !dark);
}

const fontStack = (f: string | undefined, fallback: string): string =>
  f ? `"${f.split(',')[0].trim()}", ${fallback}` : fallback;

export async function applyVaultAppearance(store: VaultStore): Promise<() => void> {
  const a = (await store.readConfigJson<Appearance>('appearance.json')) ?? {};
  vaultTheme = a.theme === 'obsidian' ? 'dark' : a.theme === 'moonstone' ? 'light' : 'system';
  applyBaseTheme();
  const root = document.body.style;
  const set: string[] = [];
  const prop = (k: string, v: string | undefined): void => {
    if (!v) return;
    root.setProperty(k, v);
    set.push(k);
  };
  prop('--font-text-theme', a.textFontFamily ? fontStack(a.textFontFamily, 'var(--font-default)') : undefined);
  prop('--font-interface-theme', a.interfaceFontFamily ? fontStack(a.interfaceFontFamily, 'var(--font-default)') : undefined);
  prop('--font-monospace-theme', a.monospaceFontFamily ? fontStack(a.monospaceFontFamily, 'var(--font-monospace-default)') : undefined);
  if (a.baseFontSize) prop('--font-text-size', `${a.baseFontSize}px`);
  if (a.accentColor) prop('--interactive-accent', a.accentColor);

  const styles: HTMLStyleElement[] = [];
  const addCss = async (rel: string, kind: string): Promise<void> => {
    const css = await store.readConfig(rel).catch(() => null);
    if (!css) return;
    const el = document.createElement('style');
    el.dataset.ocAppearance = kind;
    el.textContent = css;
    document.head.appendChild(el);
    styles.push(el);
  };
  if (a.cssTheme) await addCss(`themes/${a.cssTheme}/theme.css`, 'theme');
  for (const s of a.enabledCssSnippets ?? []) await addCss(`snippets/${s}.css`, 'snippet');

  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onMq = (): void => applyBaseTheme();
  mq.addEventListener('change', onMq);
  return () => {
    mq.removeEventListener('change', onMq);
    for (const k of set) root.removeProperty(k);
    for (const s of styles) s.remove();
  };
}
