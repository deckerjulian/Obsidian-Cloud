import { useEffect, useRef } from 'react';
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { markdownHighlighting } from './markdownHighlight';
import { obsidianMarkdown } from './obsidianSyntax';

/** A CodeMirror 6 view bound to a Y.Text with live remote cursors. */
export function Editor({
  ytext,
  awareness,
  readOnly,
  onView,
  extensions: extra,
  lineNumbers: showLineNumbers = true,
  tabSize = 4,
}: {
  ytext: Y.Text;
  awareness: Awareness | null;
  readOnly: boolean;
  onView?: (view: EditorView | null) => void;
  /** Additional CodeMirror extensions (e.g. registered by plugins). */
  extensions?: Extension[];
  lineNumbers?: boolean;
  tabSize?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const parent = ref.current;
    if (!parent) return;

    const extensions: Extension[] = [
      ...(showLineNumbers ? [lineNumbers()] : []),
      highlightActiveLine(),
      // CommonMark + GFM (tables, tasks, strikethrough) + Obsidian syntax.
      markdown({ base: markdownLanguage, extensions: [obsidianMarkdown] }),
      EditorState.tabSize.of(tabSize),
      markdownHighlighting,
      EditorView.lineWrapping,
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
      ...(extra ?? []),
    ];
    // Collaborative docs need Yjs's own undo manager: CodeMirror's history()
    // records REMOTE updates too, so Ctrl+Z would "undo" (delete) content that
    // collaborators typed — and sync that deletion to everyone.
    let undoManager: Y.UndoManager | null = null;
    if (awareness) {
      undoManager = new Y.UndoManager(ytext);
      extensions.push(
        keymap.of([...yUndoManagerKeymap, ...defaultKeymap]),
        yCollab(ytext, awareness, { undoManager }),
      );
    } else {
      extensions.push(history(), keymap.of([...defaultKeymap, ...historyKeymap]));
    }

    const view = new EditorView({
      state: EditorState.create({ doc: ytext.toString(), extensions }),
      parent,
    });
    onView?.(view);
    return () => {
      onView?.(null);
      view.destroy();
      undoManager?.destroy();
    };
  }, [ytext, awareness, readOnly, onView, extra, showLineNumbers, tabSize]);

  return <div ref={ref} className="oc-editor-host" />;
}
