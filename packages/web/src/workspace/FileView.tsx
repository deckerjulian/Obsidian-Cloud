import { useEffect, useRef, useState } from 'react';
import { pluginRegistry } from '../obsidian/host';
import type { VaultStore, VFile } from '../vault/VaultStore';

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']);
const AUDIO = new Set(['mp3', 'wav', 'm4a', 'ogg', 'flac', '3gp']);
const VIDEO = new Set(['mp4', 'webm', 'mov', 'mkv', 'ogv']);
const TEXT = new Set(['txt', 'json', 'css', 'js', 'ts', 'csv', 'base', 'canvas', 'py', 'yaml', 'yml', 'xml', 'bak', 'log', 'sh', 'ini']);
const HTML = new Set(['html', 'htm', 'xhtml']);

/**
 * Viewer for everything that isn't a Markdown note: a plugin-registered view
 * for the extension (e.g. HTML Viewer) wins; otherwise images, PDFs, media,
 * sandboxed HTML and plain text are shown natively.
 */
export function FileView({ store, file }: { store: VaultStore; file: VFile }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setVersion] = useState(0);
  useEffect(() => pluginRegistry.subscribe(() => setVersion((v) => v + 1)), []);

  const ext = file.extension;
  const viewType = pluginRegistry.extensions.get(ext);
  const pluginView = viewType ? pluginRegistry.views.get(viewType) : undefined;

  useEffect(() => {
    if (!pluginView || !hostRef.current) return;
    const el = hostRef.current;
    let unmount: (() => void) | null = null;
    try {
      unmount = pluginView.mount(el, { filePath: file.path });
    } catch (err) {
      setError(`${pluginView.pluginId}: ${(err as Error).message}`);
    }
    return () => {
      unmount?.();
      el.replaceChildren();
    };
  }, [pluginView, file.path, file.node.updatedAt]);

  useEffect(() => {
    if (pluginView) return;
    let active = true;
    setError(null);
    setUrl(null);
    setText(null);
    void (async () => {
      try {
        if (TEXT.has(ext) || HTML.has(ext)) {
          const bytes = await store.readBinary(file.path);
          if (active) setText(new TextDecoder().decode(bytes));
        } else {
          const u = await store.resourceUrl(file.path);
          if (active) setUrl(u);
        }
      } catch (err) {
        if (active) setError((err as Error).message);
      }
    })();
    return () => {
      active = false;
    };
  }, [pluginView, store, file.path, file.node.updatedAt, ext]);

  if (error) return <div className="oc-empty">{error}</div>;
  if (pluginView) return <div ref={hostRef} className="view-content oc-plugin-view" />;
  if (HTML.has(ext)) {
    if (text === null) return <div className="oc-empty">Entschlüssele…</div>;
    // Scripts never run: no allow-scripts in the sandbox (the page holds the
    // decrypted vault keys — untrusted HTML must not touch it).
    return <iframe className="oc-html-view" sandbox="" srcDoc={text} title={file.name} />;
  }
  if (TEXT.has(ext)) {
    if (text === null) return <div className="oc-empty">Entschlüssele…</div>;
    let shown = text;
    if (ext === 'json' || ext === 'canvas') {
      try {
        shown = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* show raw */
      }
    }
    return (
      <div className="oc-text-view">
        <pre>{shown}</pre>
      </div>
    );
  }
  if (!url) return <div className="oc-empty">Entschlüssele…</div>;
  if (IMAGE.has(ext)) {
    return (
      <div className="oc-image-view">
        <img src={url} alt={file.name} />
      </div>
    );
  }
  if (ext === 'pdf') return <iframe className="oc-pdf-view" src={url} title={file.name} />;
  if (AUDIO.has(ext)) {
    return (
      <div className="oc-media-view">
        <audio controls src={url} />
      </div>
    );
  }
  if (VIDEO.has(ext)) {
    return (
      <div className="oc-media-view">
        <video controls src={url} />
      </div>
    );
  }
  return (
    <div className="oc-empty">
      <p>{file.name}</p>
      <a className="oc-btn" href={url} download={file.name}>
        Herunterladen
      </a>
    </div>
  );
}
