import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/** A dark Markdown highlight style: headings get larger/bolder, like Obsidian. */
const style = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.65em', fontWeight: '700', color: '#ededf0', lineHeight: '1.3' },
  { tag: t.heading2, fontSize: '1.4em', fontWeight: '700', color: '#e6e6ea' },
  { tag: t.heading3, fontSize: '1.2em', fontWeight: '600', color: '#e0e0e6' },
  { tag: [t.heading4, t.heading5, t.heading6], fontSize: '1.05em', fontWeight: '600', color: '#d6d6dc' },
  { tag: t.heading, fontWeight: '700' },
  { tag: t.strong, fontWeight: '700', color: '#ffffff' },
  { tag: t.emphasis, fontStyle: 'italic', color: '#dcdce2' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: '#8a8a92' },
  { tag: t.link, color: '#a78bfa', textDecoration: 'underline' },
  { tag: t.url, color: '#7aa2f7' },
  { tag: t.monospace, color: '#9ece6a', fontFamily: 'var(--oc-font-mono)' },
  { tag: t.quote, color: '#9a9aa2', fontStyle: 'italic' },
  { tag: t.list, color: '#a78bfa' },
  { tag: t.contentSeparator, color: '#6b6b73' },
  // The `#`, `**`, `-` markers themselves stay faint.
  { tag: [t.meta, t.processingInstruction], color: '#6b6b73' },
]);

export const markdownHighlighting = syntaxHighlighting(style);
