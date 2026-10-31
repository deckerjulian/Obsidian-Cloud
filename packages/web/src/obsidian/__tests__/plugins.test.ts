// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// happy-dom + DOMPurify drop <pre> (fine in real browsers); sanitizing is the
// renderer's job, not what these tests check — pass HTML through unchanged.
vi.mock('dompurify', () => ({
  default: {
    sanitize: (html: string, opts?: { RETURN_DOM_FRAGMENT?: boolean }) => {
      if (!opts?.RETURN_DOM_FRAGMENT) return html;
      const t = document.createElement('template');
      t.innerHTML = html;
      return t.content;
    },
  },
}));
import { createTestVault, installFakeWorker, waitFor, type TestVault } from './fixtures';
import { PluginHost } from '../PluginHost';
import { pluginRegistry } from '../host';
import { renderMarkdown } from '../../markdown/render';
import { Component } from '../api/component';
import { TFile } from '../api/files';
import { MarkdownView } from '../api/workspace';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';

/**
 * Runs the user's REAL community plugins against the shim. The plugin builds
 * are not part of the repo; point OC_PLUGIN_FIXTURES at a folder containing
 * `<id>/{main.js,manifest.json,styles.css}` (the suite is skipped otherwise).
 */
const FIXTURES = process.env.OC_PLUGIN_FIXTURES ?? join(__dirname, 'plugin-fixtures');
const IDS = ['dataview', 'html-viewer', 'obsidian-linter', 'templater-obsidian'];
const available = IDS.every((id) => existsSync(join(FIXTURES, id, 'main.js')));

function pluginFiles(ids: string[]): Record<string, string> {
  const out: Record<string, string> = { '.obsidian/community-plugins.json': JSON.stringify([...ids, 'obsidian-cloud']) };
  for (const id of ids) {
    for (const f of ['main.js', 'manifest.json', 'styles.css', 'data.json']) {
      const p = join(FIXTURES, id, f);
      if (existsSync(p)) out[`.obsidian/plugins/${id}/${f}`] = readFileSync(p, 'utf8');
    }
  }
  return out;
}

const NOTES: Record<string, string> = {
  'Dashboard.md': '# Dashboard\n\n```dataview\nTABLE status, dauer FROM "Krankheiten" SORT file.name ASC\n```\n',
  'Krankheiten/Epilepsie.md':
    '---\nstatus: aktiv\n---\n# Epilepsie\n\ndauer:: 3\n\n- [ ] Leitlinie lesen\n- [x] Fall besprechen\n',
  'Krankheiten/Migräne.md': '---\nstatus: fertig\n---\n# Migräne\n\ndauer:: 5\n\nSiehe [[Epilepsie]].\n',
  'Seite.html': '<html><body><h1>Hallo</h1></body></html>',
};

describe.skipIf(!available)('community plugins in the browser shim', { timeout: 30_000 }, () => {
  let tv: TestVault;
  let ph: PluginHost;

  beforeAll(() => {
    installFakeWorker();
  });
  afterEach(async () => {
    await ph?.unloadAll();
    document.body.innerHTML = '';
  });

  async function boot(ids: string[], tweak?: (files: Record<string, string>) => void): Promise<void> {
    const files = { ...NOTES, ...pluginFiles(ids) };
    tweak?.(files);
    tv = await createTestVault(files);
    ph = new PluginHost(tv.host);
    const hashes = await ph.pluginCodeHashes();
    expect(Object.keys(hashes).sort()).toEqual([...ids].sort());
    const res = await ph.loadVaultPlugins();
    for (const r of res) expect(r, `${r.id}: ${r.error}`).toMatchObject({ status: 'loaded' });
    await tv.store.loadAllNotes();
  }

  async function render(md: string, sourcePath = 'Dashboard.md'): Promise<HTMLElement> {
    const el = document.body.createDiv();
    const comp = new Component();
    comp.load();
    await renderMarkdown(md, el, { store: tv.store, sourcePath, addChild: (c) => comp.addChild(c as Component) });
    return el;
  }

  it('Dataview: TABLE query over front matter + inline fields', async () => {
    await boot(['dataview']);
    const plugin = ph.app.plugins.getPlugin('dataview') as unknown as { index: { initialized: boolean } };
    await waitFor(() => plugin.index.initialized);
    const el = await render(NOTES['Dashboard.md']);
    const rows = await waitFor(() => {
      const trs = el.querySelectorAll('table.dataview tbody tr');
      return trs.length === 2 && trs[1].textContent?.includes('fertig') ? trs : null;
    });
    const text = Array.from(rows, (r) => r.textContent?.replace(/\s+/g, ' ').trim());
    expect(text[0]).toContain('Epilepsie');
    expect(text[0]).toContain('aktiv');
    expect(text[0]).toContain('3');
    expect(text[1]).toContain('Migräne');
    expect(text[1]).toContain('fertig');
    // Result links are internal links (navigable).
    expect(el.querySelector('table.dataview a.internal-link')).not.toBeNull();
    expect(pluginRegistry.commands.has('dataview:dataview-force-refresh-views')).toBe(true);
  });

  it('Dataview: TASK, LIST, inline and dataviewjs queries', async () => {
    await boot(['dataview']);
    const plugin = ph.app.plugins.getPlugin('dataview') as unknown as { index: { initialized: boolean } };
    await waitFor(() => plugin.index.initialized);

    const tasks = await render('```dataview\nTASK FROM "Krankheiten"\n```');
    const items = await waitFor(() => {
      const li = tasks.querySelectorAll('li.task-list-item');
      return li.length === 2 && tasks.textContent?.includes('Fall besprechen') ? li : null;
    });
    expect(Array.from(items, (i) => i.textContent?.trim()).join('|')).toContain('Leitlinie lesen');

    const list = await render('```dataview\nLIST WHERE status = "fertig"\n```');
    await waitFor(() => list.querySelector('ul.dataview li')?.textContent?.includes('Migräne'));

    const inline = await render('Status: `= [[Epilepsie]].status`', 'Dashboard.md');
    await waitFor(() => inline.textContent?.includes('aktiv'));

    const js = await render('```dataviewjs\ndv.paragraph("Seiten: " + dv.pages(\'"Krankheiten"\').length)\n```');
    await waitFor(() => js.textContent?.includes('Seiten: 2'));

    // User scripts use Obsidian's globals `app` and `moment` directly.
    const globals = await render(
      '```dataviewjs\nconst n = app.vault.getMarkdownFiles().filter(f => f.path.startsWith("Krankheiten/")).length;\n' +
        'const h = app.metadataCache.getFileCache(app.vault.getFileByPath("Krankheiten/Epilepsie.md")).headings[0].heading;\n' +
        'dv.paragraph(`Global: ${n} ${h} ${window.moment(0).year() > 1960}`)\n```',
    );
    await waitFor(() => globals.textContent?.includes('Global: 2 Epilepsie true'));
  });

  it('never loads plugin code from an unprotected .obsidian folder', async () => {
    tv = await createTestVault({ ...NOTES, ...pluginFiles(['dataview']) }, { protectedConfig: false });
    ph = new PluginHost(tv.host);
    expect(await ph.pluginCodeHashes()).toEqual({});
    expect(await ph.loadVaultPlugins()).toEqual([]);
    expect(ph.app.plugins.getPlugin('dataview')).toBeNull();
    // Settings like appearance.json are still read from it.
    expect(tv.store.configFiles()).toContain('community-plugins.json');
  });

  it('Dataview: index follows edits', async () => {
    await boot(['dataview']);
    const plugin = ph.app.plugins.getPlugin('dataview') as unknown as { index: { initialized: boolean } };
    await waitFor(() => plugin.index.initialized);
    await tv.store.write('Krankheiten/Migräne.md', '---\nstatus: neu\n---\n# Migräne\n');
    const el = await render('```dataview\nLIST WHERE status = "neu"\n```');
    await waitFor(() => el.querySelector('ul.dataview li')?.textContent?.includes('Migräne'));
  });

  it('HTML Viewer: registers a view for html and renders the file', async () => {
    await boot(['html-viewer']);
    expect(pluginRegistry.extensions.get('html')).toBe('html-view');
    expect(pluginRegistry.extensions.get('xhtml')).toBe('html-view');
    const view = pluginRegistry.views.get('html-view')!;
    const container = document.body.createDiv();
    const close = view.mount(container, { filePath: 'Seite.html' });
    const iframe = await waitFor(() => container.querySelector('iframe'));
    expect(iframe.getAttribute('sandbox')).not.toBeNull();
    close();
  });

  it('Templater + Linter load and register commands; linter runs on the active editor', async () => {
    await boot(['templater-obsidian', 'obsidian-linter'], (files) => {
      // The user's config enables no rules; turn one on so linting is observable.
      const data = JSON.parse(files['.obsidian/plugins/obsidian-linter/data.json']);
      data.ruleConfigs['trailing-spaces'].enabled = true;
      files['.obsidian/plugins/obsidian-linter/data.json'] = JSON.stringify(data);
    });
    const ids = [...pluginRegistry.commands.keys()];
    expect(ids.some((i) => i.startsWith('templater-obsidian:'))).toBe(true);
    expect(ids.some((i) => i.startsWith('obsidian-linter:'))).toBe(true);
    expect(pluginRegistry.settingTabs.has('obsidian-linter')).toBe(true);
    expect(pluginRegistry.settingTabs.has('templater-obsidian')).toBe(true);

    // The settings tabs render without throwing.
    for (const id of ['obsidian-linter', 'templater-obsidian']) {
      const box = document.body.createDiv();
      const unmount = pluginRegistry.settingTabs.get(id)!.mount(box);
      expect(box.querySelector('.setting-item')).not.toBeNull();
      unmount();
    }

    // Active note in reading mode → MarkdownView with a text-backed editor.
    tv.host.activePath = 'Krankheiten/Migräne.md';
    const view = ph.app.workspace.getActiveViewOfType(MarkdownView);
    expect(view?.file).toBeInstanceOf(TFile);
    expect(view!.editor.getValue()).toContain('# Migräne');

    // Source mode: a live CodeMirror view → the Linter's editor command works.
    const cm = new EditorView({
      state: EditorState.create({ doc: '#  Titel   \n\n\n\nText   \n', extensions: pluginRegistry.editorExtensions }),
      parent: document.body.createDiv(),
    });
    tv.host.mode = 'source';
    (tv.host as { getActiveEditorView: () => EditorView | null }).getActiveEditorView = () => cm;
    const lint = pluginRegistry.commands.get('obsidian-linter:lint-file')!;
    expect(lint.check()).toBe(true);
    await lint.run();
    await waitFor(() => cm.state.doc.toString() !== '#  Titel   \n\n\n\nText   \n');
    expect(cm.state.doc.toString()).not.toMatch(/Text {3}/);
    cm.destroy();
  });

  it('vault.getResourcePath placeholders resolve to blob URLs in the DOM', async () => {
    await boot([]);
    const png = new Uint8Array([137, 80, 78, 71]);
    await tv.store.create('bild.png', png);
    const file = ph.app.vault.getFileByPath('bild.png')!;
    const src = ph.app.vault.getResourcePath(file);
    const img = document.body.createEl('img');
    img.src = src;
    await waitFor(() => img.getAttribute('src')?.startsWith('blob:'));
    // Afterwards the URL is cached and returned synchronously.
    expect(ph.app.vault.getResourcePath(file)).toMatch(/^blob:/);
  });

  it('unloadAll removes registrations, styles and processors', async () => {
    await boot(['dataview', 'html-viewer']);
    expect(document.head.querySelector('style[data-plugin="dataview"]')).not.toBeNull();
    await ph.unloadAll();
    expect(pluginRegistry.commands.size).toBe(0);
    expect(pluginRegistry.views.size).toBe(0);
    expect(document.head.querySelector('style[data-plugin]')).toBeNull();
    const { markdownHooks } = await import('../../markdown/render');
    expect(markdownHooks.codeBlockProcessors.has('dataview')).toBe(false);
    expect(markdownHooks.postProcessors.length).toBe(0);
    ph = undefined as unknown as PluginHost;
  });
});
