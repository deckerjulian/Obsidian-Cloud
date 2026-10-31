import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { obsidianTags } from './obsidianSyntax';

/** Markdown highlight style (colours from the Obsidian CSS variables, light/dark). */
const style = HighlightStyle.define([
  // Heading sizes come from the line classes below (like Obsidian's HyperMD-header-N).
  { tag: t.heading1, color: 'var(--h1-color, var(--text-normal))' },
  { tag: t.heading2, color: 'var(--h2-color, var(--text-normal))' },
  { tag: t.heading3, color: 'var(--h3-color, var(--text-normal))' },
  { tag: [t.heading4, t.heading5, t.heading6], color: 'var(--text-normal)' },
  { tag: t.heading, fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--text-muted)' },
  { tag: t.link, color: 'var(--text-accent)', textDecoration: 'underline' },
  { tag: t.url, color: 'var(--text-accent)' },
  { tag: t.monospace, color: 'var(--code-normal, var(--text-normal))', fontFamily: 'var(--font-monospace)' },
  { tag: t.quote, color: 'var(--text-muted)' },
  { tag: t.list, color: 'var(--list-marker-color, var(--text-accent))' },
  { tag: t.contentSeparator, color: 'var(--text-faint)' },
  { tag: t.comment, color: 'var(--text-faint)' },
  { tag: obsidianTags.internalLink, color: 'var(--link-color, var(--text-accent))', textDecoration: 'underline' },
  { tag: obsidianTags.highlight, class: 'cm-highlight' },
  { tag: obsidianTags.hashtag, class: 'cm-hashtag' },
  { tag: obsidianTags.math, color: 'var(--text-accent)', fontFamily: 'var(--font-monospace)' },
  // The `#`, `**`, `-` markers themselves stay faint.
  { tag: [t.meta, t.processingInstruction], color: 'var(--text-faint)' },
]);

/** Line classes for ATX headings (`HyperMD-header HyperMD-header-N`). */
const headingLines = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = this.build(u.view);
    }
    build(view: EditorView): DecorationSet {
      const b = new RangeSetBuilder<Decoration>();
      for (const { from, to } of view.visibleRanges) {
        syntaxTree(view.state).iterate({
          from,
          to,
          enter: (n) => {
            const m = /^ATXHeading(\d)$/.exec(n.name);
            if (m) {
              b.add(view.state.doc.lineAt(n.from).from, view.state.doc.lineAt(n.from).from, Decoration.line({ class: `HyperMD-header HyperMD-header-${m[1]}` }));
              return false;
            }
            if (n.name !== 'Document' && !n.name.endsWith('List') && n.name !== 'ListItem' && n.name !== 'Blockquote') return false;
            return;
          },
        });
      }
      return b.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

export const markdownHighlighting = [syntaxHighlighting(style), headingLines];
