import { useEffect, useRef, useState } from 'react';
import { pluginRegistry } from '../obsidian/host';
import type { TrustState } from './usePlugins';
import { LIcon } from './Sidebar';
import type { EditorPrefs, EditorPrefsApi } from './editorPrefs';

/** 'editor', 'plugins' (overview) or a plugin id. */
export type SettingsTab = string;

/** Settings dialog: editor options, community plugin overview + each plugin's own tab. */
export function PluginSettings({
  initialTab = 'plugins',
  editorPrefs,
  trust,
  onReset,
  onClose,
}: {
  initialTab?: SettingsTab;
  editorPrefs: EditorPrefsApi;
  trust: TrustState;
  onReset: () => void;
  onClose: () => void;
}) {
  const [, setV] = useState(0);
  useEffect(() => pluginRegistry.subscribe(() => setV((v) => v + 1)), []);
  const [tabId, setTabId] = useState<SettingsTab>(initialTab);
  useEffect(() => setTabId(initialTab), [initialTab]);
  const tab = pluginRegistry.settingTabs.get(tabId);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!tab || !ref.current) return;
    const el = ref.current;
    const cleanup = tab.mount(el);
    return () => {
      cleanup();
      el.replaceChildren();
    };
  }, [tab]);

  return (
    <div className="modal-container mod-dim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal mod-settings oc-plugin-settings">
        <div className="modal-close-button" onClick={onClose}>
          <LIcon name="x" size={18} />
        </div>
        <div className="vertical-tabs-container">
          <div className="vertical-tab-header">
            <div className="vertical-tab-header-group-title">Optionen</div>
            <div className={`vertical-tab-nav-item${tabId === 'editor' ? ' is-active' : ''}`} onClick={() => setTabId('editor')}>
              Editor
            </div>
            <div className="vertical-tab-header-group-title">Community-Plugins</div>
            <div className={`vertical-tab-nav-item${tabId === 'plugins' ? ' is-active' : ''}`} onClick={() => setTabId('plugins')}>
              Übersicht
            </div>
            {[...pluginRegistry.settingTabs.values()].map((t) => (
              <div key={t.id} className={`vertical-tab-nav-item${tabId === t.id ? ' is-active' : ''}`} onClick={() => setTabId(t.id)}>
                {t.name}
              </div>
            ))}
          </div>
          <div className="vertical-tab-content-container">
            <div className="vertical-tab-content">
              {tab ? (
                <div ref={ref} />
              ) : tabId === 'editor' ? (
                <EditorSettings api={editorPrefs} />
              ) : (
                <>
                  <h2>Community-Plugins</h2>
                  <p className="oc-faint">
                    Plugins kommen aus dem Ordner <code>.obsidian/plugins</code> dieses Vaults (vom Desktop
                    synchronisiert) und laufen hier im Browser.{' '}
                    {trust.kind === 'restricted' && 'Dieser Vault ist im eingeschränkten Modus – Plugins sind aus.'}
                    {trust.kind === 'none' && 'Dieser Vault hat keine Community-Plugins.'}
                  </p>
                  {pluginRegistry.plugins.map((p) => (
                    <div key={p.id} className="setting-item">
                      <div className="setting-item-info">
                        <div className="setting-item-name">
                          {p.name} <span className="oc-faint">{p.version}</span>
                        </div>
                        <div className="setting-item-description">
                          {p.status === 'loaded' ? 'Aktiv' : p.status === 'skipped' ? `Übersprungen${p.error ? `: ${p.error}` : ''}` : `Fehler: ${p.error}`}
                        </div>
                      </div>
                      <div className="setting-item-control">
                        {pluginRegistry.settingTabs.has(p.id) && <button onClick={() => setTabId(p.id)}>Optionen</button>}
                      </div>
                    </div>
                  ))}
                  <div className="setting-item">
                    <div className="setting-item-info">
                      <div className="setting-item-name">Plugin-Vertrauen zurücksetzen</div>
                      <div className="setting-item-description">Beim nächsten Laden erneut fragen, ob die Plugins laufen dürfen.</div>
                    </div>
                    <div className="setting-item-control">
                      <button onClick={onReset}>Zurücksetzen</button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className={`checkbox-container${value ? ' is-enabled' : ''}`} onClick={() => onChange(!value)} role="switch" aria-checked={value}>
      <input type="checkbox" checked={value} readOnly tabIndex={-1} />
    </div>
  );
}

function EditorSettings({ api }: { api: EditorPrefsApi }) {
  const { prefs, vault, overridden, set, reset } = api;
  const fromVault = (k: keyof EditorPrefs): string | null =>
    overridden.includes(k) ? `Vault-Einstellung (Desktop): ${describe(k, vault[k])}` : null;
  const item = (k: keyof EditorPrefs, name: string, desc: string, control: React.ReactNode) => (
    <div className="setting-item" key={k}>
      <div className="setting-item-info">
        <div className="setting-item-name">{name}</div>
        <div className="setting-item-description">
          {desc}
          {fromVault(k) && <div className="oc-faint">{fromVault(k)}</div>}
        </div>
      </div>
      <div className="setting-item-control">{control}</div>
    </div>
  );
  return (
    <>
      <h2>Editor</h2>
      <p className="oc-faint">
        Voreinstellungen kommen aus <code>.obsidian/app.json</code> deines Vaults (wie am Desktop). Änderungen hier gelten
        für diesen Browser.
      </p>
      <div className="setting-item setting-item-heading">
        <div className="setting-item-info">
          <div className="setting-item-name">Allgemein</div>
        </div>
      </div>
      {item(
        'defaultViewMode',
        'Standardansicht für neue Tabs',
        'Ansicht, in der Notizen geöffnet werden.',
        <select value={prefs.defaultViewMode} onChange={(e) => set({ defaultViewMode: e.target.value as EditorPrefs['defaultViewMode'] })}>
          <option value="source">Bearbeiten</option>
          <option value="preview">Lesen</option>
        </select>,
      )}
      {item(
        'livePreview',
        'Standard-Bearbeitungsmodus',
        'Live Preview zeigt Formatierung, Links, Tabellen und Callouts beim Schreiben gerendert an; der Quelltextmodus zeigt reines Markdown.',
        <select value={prefs.livePreview ? 'live' : 'source'} onChange={(e) => set({ livePreview: e.target.value === 'live' })}>
          <option value="live">Live Preview</option>
          <option value="source">Quelltextmodus</option>
        </select>,
      )}
      <div className="setting-item setting-item-heading">
        <div className="setting-item-info">
          <div className="setting-item-name">Darstellung</div>
        </div>
      </div>
      {item(
        'readableLineLength',
        'Lesbare Zeilenlänge',
        'Begrenzt die Textbreite auf ca. 750 px. Ausgeschaltet nutzt die Notiz die volle Fensterbreite.',
        <Toggle value={prefs.readableLineLength} onChange={(v) => set({ readableLineLength: v })} />,
      )}
      {item(
        'showLineNumber',
        'Zeilennummern anzeigen',
        'Zeilennummern im Editor.',
        <Toggle value={prefs.showLineNumber} onChange={(v) => set({ showLineNumber: v })} />,
      )}
      {overridden.length > 0 && (
        <div className="setting-item">
          <div className="setting-item-info">
            <div className="setting-item-name">Auf Vault-Einstellungen zurücksetzen</div>
            <div className="setting-item-description">Verwirft die Änderungen dieses Browsers.</div>
          </div>
          <div className="setting-item-control">
            <button onClick={reset}>Zurücksetzen</button>
          </div>
        </div>
      )}
    </>
  );
}

function describe(k: keyof EditorPrefs, v: EditorPrefs[keyof EditorPrefs]): string {
  if (k === 'defaultViewMode') return v === 'preview' ? 'Lesen' : 'Bearbeiten';
  if (k === 'livePreview') return v ? 'Live Preview' : 'Quelltextmodus';
  if (typeof v === 'boolean') return v ? 'an' : 'aus';
  return String(v);
}
