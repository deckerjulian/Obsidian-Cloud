import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fuzzySort, type FuzzyMatch } from './fuzzy';

/** Highlight the fuzzy-matched characters. */
function Highlight({ text, match }: { text: string; match: FuzzyMatch }): ReactNode {
  if (!match.indices.length) return text;
  const set = new Set(match.indices);
  return Array.from(text).map((ch, i) =>
    set.has(i) ? (
      <span key={i} className="suggestion-highlight">
        {ch}
      </span>
    ) : (
      ch
    ),
  );
}

export interface PaletteItem {
  id: string;
  title: string;
  note?: string;
  run: () => void;
}

/**
 * Obsidian's suggestion modal (quick switcher, command palette): type to
 * fuzzy-filter, ↑/↓ to move, Enter to run, Esc to close.
 */
export function Palette({
  placeholder,
  items,
  onClose,
  emptyText,
  onCreate,
}: {
  placeholder: string;
  items: PaletteItem[];
  onClose: () => void;
  emptyText?: string;
  /** Offer "create <query>" when nothing matches exactly (quick switcher). */
  onCreate?: (query: string) => void;
}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const results = useMemo(
    () => (q ? fuzzySort(q, items, (i) => i.title, 60) : items.slice(0, 60).map((item) => ({ item, match: { score: 0, indices: [] } }))),
    [q, items],
  );
  const canCreate = !!onCreate && q.trim() !== '' && !items.some((i) => i.title.toLowerCase() === q.trim().toLowerCase());
  const total = results.length + (canCreate ? 1 : 0);
  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const choose = (i: number): void => {
    if (i < results.length) {
      onClose();
      results[i].item.run();
    } else if (canCreate) {
      onClose();
      onCreate!(q.trim());
    }
  };

  return (
    <div className="modal-container oc-palette-container" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="prompt">
        <div className="prompt-input-container">
          <input
            className="prompt-input"
            autoFocus
            placeholder={placeholder}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel((s) => Math.min(total - 1, s + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                choose(sel);
              } else if (e.key === 'Escape') onClose();
            }}
          />
        </div>
        <div className="prompt-results" ref={listRef}>
          {results.map(({ item, match }, i) => (
            <div
              key={item.id}
              className={`suggestion-item${i === sel ? ' is-selected' : ''}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => choose(i)}
            >
              <div className="suggestion-content">
                <div className="suggestion-title">
                  <Highlight text={item.title} match={match} />
                </div>
                {item.note && <div className="suggestion-note">{item.note}</div>}
              </div>
            </div>
          ))}
          {canCreate && (
            <div
              className={`suggestion-item${sel === results.length ? ' is-selected' : ''}`}
              onMouseEnter={() => setSel(results.length)}
              onClick={() => choose(results.length)}
            >
              <div className="suggestion-content">
                <div className="suggestion-title">„{q.trim()}“ erstellen</div>
              </div>
            </div>
          )}
          {total === 0 && <div className="suggestion-empty">{emptyText ?? 'Keine Treffer.'}</div>}
        </div>
      </div>
    </div>
  );
}
