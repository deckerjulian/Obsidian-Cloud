import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: false });

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Pull a leading YAML front-matter block out and render it as a small table. */
function extractFrontmatter(md: string): { html: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { html: '', body: md };
  const rows = m[1]
    .split('\n')
    .map((line) => {
      const i = line.indexOf(':');
      if (i < 0 || !line.trim()) return '';
      const k = line.slice(0, i).trim();
      const v = wikilinks(
        line
          .slice(i + 1)
          .trim()
          .replace(/^["']|["']$/g, ''),
      );
      return `<tr><td class="oc-fm-key">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`;
    })
    .join('');
  return { html: `<table class="oc-frontmatter">${rows}</table>`, body: md.slice(m[0].length) };
}

/** [[target|alias]] / [[target]] → readable text (links aren't routable here). */
function wikilinks(md: string): string {
  return md
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1');
}

/** Obsidian callouts: a blockquote starting with `[!type] Title`. */
function renderCallouts(html: string): string {
  return html.replace(/<blockquote>([\s\S]*?)<\/blockquote>/g, (all, inner: string) => {
    const m = /^\s*<p>\s*\[!(\w+)\]([^\n<]*)/.exec(inner);
    if (!m) return all;
    const type = m[1].toLowerCase();
    const title = m[2].trim();
    const body = inner.replace(/^\s*<p>\s*\[!\w+\][^\n<]*\r?\n?/, '<p>').replace(/<p>\s*<\/p>/, '');
    return (
      `<div class="oc-callout oc-callout-${type}">` +
      `<div class="oc-callout-title">${escapeHtml(title) || type.toUpperCase()}</div>` +
      `<div class="oc-callout-body">${body}</div></div>`
    );
  });
}

/**
 * Sanitize the rendered HTML. Notes come from collaborators, but a malicious
 * note must never execute script in a viewer's session — an XSS here could use
 * the viewer's unlocked E2EE key to decrypt everything. DOMPurify, not regexes.
 */
function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    // marked emits standard HTML; our own wrappers only add divs/tables/classes.
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button'],
  });
}

/** Render a markdown note to display HTML (front-matter, tables, callouts, …). */
export function renderMarkdown(md: string): string {
  const { html: fm, body } = extractFrontmatter(md);
  const rendered = marked.parse(wikilinks(body)) as string;
  return sanitize(fm + renderCallouts(rendered));
}
