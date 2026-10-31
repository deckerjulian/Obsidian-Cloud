import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorView } from '@codemirror/view';
import { hasCapability } from '@oc/shared';
import { useAuth } from '../auth/AuthContext';
import { useYDoc } from '../editor/useYDoc';
import { Editor } from '../editor/Editor';
import { MarkdownToolbar } from '../editor/MarkdownToolbar';
import { presenceFor } from '../editor/presence';
import { livePreview as livePreviewExtension } from '../editor/livePreview';
import { editorLivePreviewField } from '../obsidian/api/workspace';
import { renderMarkdown } from '../markdown/render';
import { pluginRegistry, type ViewMode } from '../obsidian/host';
import type { VaultStore, VFile } from '../vault/VaultStore';

interface Child {
  load?(): void;
  unload?(): void;
  onload?(): void;
}

/**
 * A Markdown note, Obsidian-style: reading view (rendered, with links, embeds,
 * callouts, plugin code blocks) or editing view (collaborative CodeMirror, in
 * Live Preview or source mode).
 * Both modes share ONE live, end-to-end-encrypted Yjs document, so edits from
 * other devices show up immediately in either mode.
 */
export function NoteView({
  store,
  file,
  mode,
  livePreview = true,
  readableLineLength = true,
  showLineNumber = false,
  tabSize = 4,
  subpath,
  onEditorView,
  onEditorChange,
  onOpenLink,
}: {
  store: VaultStore;
  file: VFile;
  mode: ViewMode;
  /** Editing mode: Live Preview (true) or plain source. */
  livePreview?: boolean;
  readableLineLength?: boolean;
  showLineNumber?: boolean;
  tabSize?: number;
  subpath?: string;
  onEditorView?: (view: EditorView | null) => void;
  /** Source-mode edits (plugins listen for 'editor-change'). */
  onEditorChange?: () => void;
  onOpenLink: (linktext: string, sourcePath: string, newLeaf: boolean) => void;
}) {
  const { user } = useAuth();
  const docId = file.node.docId as string;
  const { ydoc, ytext, provider, awareness, synced, keyState } = useYDoc(docId);
  const writable = hasCapability(file.node.capabilities, 'edit');
  const [view, setView] = useState<EditorView | null>(null);
  const readingRef = useRef<HTMLDivElement>(null);
  const children = useRef<Child[]>([]);
  const [extVersion, setExtVersion] = useState(pluginRegistry.getVersion());

  useEffect(() => pluginRegistry.subscribe(() => setExtVersion(pluginRegistry.getVersion())), []);
  // Plugins mutate the registry array in place; hand the editor a new array
  // when it changed so CodeMirror is reconfigured (incl. editorInfoField).
  // Link clicks in Live Preview go through a ref, so a new handler does not
  // rebuild the editor.
  const openLinkRef = useRef(onOpenLink);
  openLinkRef.current = onOpenLink;
  const lpExtension = useMemo(
    () =>
      livePreview
        ? livePreviewExtension({ store, sourcePath: file.path, onOpenLink: (l, s, n) => openLinkRef.current(l, s, n) })
        : [],
    [livePreview, store, file.path],
  );
  const editorExtensions = useMemo(
    () => [...pluginRegistry.editorExtensions, editorLivePreviewField.init(() => livePreview), lpExtension],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [extVersion, lpExtension],
  );

  useEffect(() => {
    if (mode !== 'source' || !onEditorChange) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const fn = (): void => {
      if (t) clearTimeout(t);
      t = setTimeout(onEditorChange, 50);
    };
    ytext.observe(fn);
    return () => {
      if (t) clearTimeout(t);
      ytext.unobserve(fn);
    };
  }, [mode, ytext, onEditorChange]);

  // The vault index follows this live document while it is open.
  useEffect(() => store.attachLiveDoc(file.path, ydoc), [store, file.path, ydoc]);

  useEffect(() => {
    if (!awareness || !user) return;
    awareness.setLocalStateField('user', presenceFor(user.id, user.displayName));
  }, [awareness, user]);

  const handleView = useCallback(
    (v: EditorView | null) => {
      setView(v);
      onEditorView?.(v);
    },
    [onEditorView],
  );

  const toggleTask = useCallback(
    (line: number, checked: boolean) => {
      if (!writable) return;
      const text = ytext.toString();
      const lines = text.split('\n');
      const l = lines[line];
      if (l === undefined) return;
      const next = l.replace(/^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+)\[(.)\]/, (_m, pre: string) => `${pre}[${checked ? 'x' : ' '}]`);
      if (next === l) return;
      const offset = lines.slice(0, line).reduce((s, x) => s + x.length + 1, 0);
      ydoc.transact(() => {
        ytext.delete(offset, l.length);
        ytext.insert(offset, next);
      });
    },
    [writable, ytext, ydoc],
  );

  // Reading view: render (debounced) whenever the live text changes.
  useEffect(() => {
    if (mode !== 'preview') return;
    const el = readingRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let seq = 0;
    let lastText: string | null = null;
    const render = async (): Promise<void> => {
      const text = synced || ytext.length > 0 ? ytext.toString() : store.cachedText(file.path);
      if (text === null || text === lastText) return;
      lastText = text;
      const my = ++seq;
      const scroll = el.parentElement?.scrollTop ?? 0;
      const next = document.createElement('div');
      next.className = 'markdown-preview-sizer markdown-preview-section';
      const title = next.createDiv({ cls: 'inline-title', text: file.basename });
      void title;
      const fresh: Child[] = [];
      await renderMarkdown(text, next, {
        store,
        sourcePath: file.path,
        showProperties: true,
        onOpenLink,
        onToggleTask: writable ? toggleTask : undefined,
        addChild: (c) => {
          fresh.push(c);
          if (c.load) c.load();
          else c.onload?.();
        },
      });
      if (my !== seq) {
        fresh.forEach((c) => c.unload?.());
        return;
      }
      children.current.forEach((c) => c.unload?.());
      children.current = fresh;
      el.replaceChildren(next);
      if (el.parentElement) el.parentElement.scrollTop = scroll;
    };
    const schedule = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void render(), lastText === null ? 0 : 250);
    };
    schedule();
    ytext.observe(schedule);
    return () => {
      if (timer) clearTimeout(timer);
      ytext.unobserve(schedule);
    };
  }, [mode, ytext, synced, store, file.path, file.basename, onOpenLink, writable, toggleTask, extVersion]);

  useEffect(
    () => () => {
      children.current.forEach((c) => c.unload?.());
      children.current = [];
    },
    [],
  );

  // Jump to a heading / block from the link (#Heading, #^block).
  useEffect(() => {
    if (!subpath || mode !== 'preview') return;
    const t = setTimeout(() => {
      const el = readingRef.current;
      if (!el) return;
      const want = subpath.replace(/^#\^?/, '').toLowerCase();
      const target = Array.from(el.querySelectorAll<HTMLElement>('[data-heading]')).find(
        (h) => (h.dataset.heading ?? '').trim().toLowerCase() === want,
      );
      target?.scrollIntoView({ block: 'start' });
    }, 400);
    return () => clearTimeout(t);
  }, [subpath, mode, synced]);

  // …and in the editor: put the cursor on the heading / block.
  useEffect(() => {
    if (!subpath || mode !== 'source' || !view || !synced) return;
    const want = subpath.replace(/^#\^?/, '').trim().toLowerCase();
    const cache = store.getFileCache(file.path);
    const offset =
      cache?.headings?.find((h) => h.heading.trim().toLowerCase() === want)?.position.start.offset ??
      (subpath.startsWith('#^') ? cache?.blocks?.[want]?.position.start.offset : undefined);
    if (offset === undefined || offset > view.state.doc.length) return;
    view.dispatch({ selection: { anchor: offset }, effects: EditorView.scrollIntoView(offset, { y: 'start', yMargin: 40 }) });
  }, [subpath, mode, view, synced, store, file.path]);

  if (keyState === 'locked' || keyState === 'no-key') {
    return (
      <div className="oc-empty">
        <p>{keyState === 'locked' ? 'Verschlüsselung ist gesperrt.' : 'Kein Schlüssel für diese Notiz (nicht mit dir geteilt).'}</p>
      </div>
    );
  }

  return mode === 'preview' ? (
    <div className="markdown-reading-view">
      <div className={`markdown-preview-view markdown-rendered node-insert-event${readableLineLength ? ' is-readable-line-width' : ''}`}>
        <div ref={readingRef} />
      </div>
    </div>
  ) : (
    <div
      className={`markdown-source-view mod-cm6${livePreview ? ' is-live-preview' : ''}${readableLineLength ? ' is-readable-line-width' : ''}`}
    >
      {provider && (
        <MarkdownToolbar view={view} mode="edit" disabled={!writable} />
      )}
      <div className="oc-source-inline-title inline-title">{file.basename}</div>
      {provider ? (
        <Editor
          ytext={ytext}
          awareness={awareness}
          readOnly={!writable}
          onView={handleView}
          extensions={editorExtensions}
          lineNumbers={showLineNumber}
          tabSize={tabSize}
        />
      ) : (
        <div className="oc-empty">Entschlüssele…</div>
      )}
    </div>
  );
}
