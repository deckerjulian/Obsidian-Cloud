import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/** Wrap each selection with a marker (bold, italic, code, strikethrough). */
export function wrapInline(view: EditorView, marker: string): void {
  const { state } = view;
  view.dispatch(
    state.changeByRange((range) => {
      const text = state.sliceDoc(range.from, range.to) || 'text';
      const insert = `${marker}${text}${marker}`;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.range(range.from + marker.length, range.from + marker.length + text.length),
      };
    }),
  );
  view.focus();
}

/** Prepend a prefix to every line in the selection (heading, quote, list). */
export function prefixLines(view: EditorView, prefix: string | ((index: number) => string)): void {
  const { state } = view;
  const range = state.selection.main;
  const first = state.doc.lineAt(range.from).number;
  const last = state.doc.lineAt(range.to).number;
  const changes = [];
  let i = 0;
  for (let ln = first; ln <= last; ln++) {
    const line = state.doc.line(ln);
    changes.push({ from: line.from, insert: typeof prefix === 'function' ? prefix(i++) : prefix });
  }
  view.dispatch({ changes });
  view.focus();
}

/** Insert a block of text at the cursor (link, table template). */
export function insertBlock(view: EditorView, text: string): void {
  const pos = view.state.selection.main.head;
  view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length } });
  view.focus();
}

const TABLE_TEMPLATE = '\n| Column | Column |\n| --- | --- |\n| Cell | Cell |\n';

export const TABLE = TABLE_TEMPLATE;
