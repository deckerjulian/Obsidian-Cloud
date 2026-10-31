import { Marked, type TokenizerAndRendererExtension, type Tokens } from 'marked';

/**
 * Markdown → HTML with Obsidian's syntax extensions, emitting the same DOM
 * hooks Obsidian does so the post-processor (and plugin CSS) can find them:
 *  - [[wikilinks]]   → <a class="internal-link" data-href>
 *  - ![[embeds]]     → <span class="internal-embed" src alt>
 *  - ==highlight==   → <mark>
 *  - %%comments%%    → dropped
 *  - #tags           → <a class="tag" href="#tag">
 *  - $math$ / $$math$$ → <span class="math" data-tex> (KaTeX later)
 *  - trailing ^block-ids → dropped from the output
 * Callouts are built from blockquotes in the DOM pass (render.ts).
 */

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const wikiEmbed: TokenizerAndRendererExtension = {
  name: 'wikiEmbed',
  level: 'inline',
  start: (src) => src.indexOf('![['),
  tokenizer(src) {
    const m = /^!\[\[([^\]\n]+?)\]\]/.exec(src);
    if (!m) return undefined;
    const inner = m[1];
    const pipe = inner.indexOf('|');
    const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
    const alt = pipe >= 0 ? inner.slice(pipe + 1) : '';
    return { type: 'wikiEmbed', raw: m[0], target, alt };
  },
  renderer(t) {
    const { target, alt } = t as unknown as { target: string; alt: string };
    return `<span class="internal-embed" src="${esc(target)}" alt="${esc(alt)}"></span>`;
  },
};

const wikiLink: TokenizerAndRendererExtension = {
  name: 'wikiLink',
  level: 'inline',
  start: (src) => src.indexOf('[['),
  tokenizer(src) {
    const m = /^\[\[([^\]\n]+?)\]\]/.exec(src);
    if (!m) return undefined;
    const inner = m[1];
    const pipe = inner.indexOf('|');
    const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
    let text = pipe >= 0 ? inner.slice(pipe + 1) : target;
    // Obsidian shows "Note > Heading" for [[Note#Heading]] without alias.
    if (pipe < 0 && target.includes('#')) {
      const [p, ...rest] = target.split('#');
      text = p ? `${p} > ${rest.join(' > ')}` : rest.join(' > ');
    }
    return { type: 'wikiLink', raw: m[0], target, text };
  },
  renderer(t) {
    const { target, text } = t as unknown as { target: string; text: string };
    return `<a class="internal-link" data-href="${esc(target)}" href="${esc(target)}">${esc(text)}</a>`;
  },
};

const highlight: TokenizerAndRendererExtension = {
  name: 'highlight',
  level: 'inline',
  start: (src) => src.indexOf('=='),
  tokenizer(src) {
    const m = /^==(?=\S)([\s\S]*?\S)==/.exec(src);
    if (!m) return undefined;
    return { type: 'highlight', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
  },
  renderer(t) {
    return `<mark>${this.parser.parseInline((t as Tokens.Generic).tokens ?? [])}</mark>`;
  },
};

const commentInline: TokenizerAndRendererExtension = {
  name: 'commentInline',
  level: 'inline',
  start: (src) => src.indexOf('%%'),
  tokenizer(src) {
    const m = /^%%[\s\S]*?%%/.exec(src);
    return m ? { type: 'commentInline', raw: m[0] } : undefined;
  },
  renderer: () => '',
};

const commentBlock: TokenizerAndRendererExtension = {
  name: 'commentBlock',
  level: 'block',
  start: (src) => src.match(/^%%/m)?.index,
  tokenizer(src) {
    const m = /^%%[\s\S]*?(?:%%|$)[^\n]*(?:\n|$)/.exec(src);
    return m ? { type: 'commentBlock', raw: m[0] } : undefined;
  },
  renderer: () => '',
};

const tag: TokenizerAndRendererExtension = {
  name: 'tag',
  level: 'inline',
  // Only at a word boundary (start, or after whitespace) — not "C#" or URLs.
  start(src) {
    const m = /(^|\s)#[\p{L}_\-/]/u.exec(src);
    return m ? m.index + m[1].length : undefined;
  },
  tokenizer(src) {
    const m = /^#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/u.exec(src);
    return m ? { type: 'tag', raw: m[0], tag: m[1] } : undefined;
  },
  renderer(t) {
    const { tag: name } = t as unknown as { tag: string };
    return `<a href="#${esc(name)}" class="tag" target="_blank" rel="noopener">#${esc(name)}</a>`;
  },
};

const mathBlock: TokenizerAndRendererExtension = {
  name: 'mathBlock',
  level: 'block',
  start: (src) => src.match(/^\$\$/m)?.index,
  tokenizer(src) {
    const m = /^\$\$([\s\S]+?)\$\$[^\n]*(?:\n|$)/.exec(src);
    return m ? { type: 'mathBlock', raw: m[0], tex: m[1].trim() } : undefined;
  },
  renderer(t) {
    const { tex } = t as unknown as { tex: string };
    return `<div class="math math-block" data-tex="${esc(tex)}">${esc(tex)}</div>`;
  },
};

const mathInline: TokenizerAndRendererExtension = {
  name: 'mathInline',
  level: 'inline',
  start: (src) => src.indexOf('$'),
  tokenizer(src) {
    // Obsidian: $…$ with no space just inside the dollars (so "$5 and $6" stays text).
    const m = /^\$(?=\S)((?:\\.|[^$\\\n])+?)(?<=\S)\$(?!\d)/.exec(src);
    return m ? { type: 'mathInline', raw: m[0], tex: m[1] } : undefined;
  },
  renderer(t) {
    const { tex } = t as unknown as { tex: string };
    return `<span class="math math-inline" data-tex="${esc(tex)}">${esc(tex)}</span>`;
  },
};

const blockId: TokenizerAndRendererExtension = {
  name: 'blockId',
  level: 'inline',
  start(src) {
    const m = /\s\^[A-Za-z0-9-]+\s*$/.exec(src);
    return m ? m.index : undefined;
  },
  tokenizer(src) {
    const m = /^\s\^([A-Za-z0-9-]+)\s*$/.exec(src);
    return m ? { type: 'blockId', raw: m[0], id: m[1] } : undefined;
  },
  renderer: () => '',
};

export const obsidianMarked = new Marked({ gfm: true, breaks: true });
obsidianMarked.use({
  extensions: [
    commentBlock,
    mathBlock,
    wikiEmbed,
    wikiLink,
    highlight,
    commentInline,
    mathInline,
    tag,
    blockId,
  ],
  renderer: {
    // Task list items carry Obsidian's classes + data-task (for styling/toggling).
    listitem(item: Tokens.ListItem) {
      const body = this.parser.parse(item.tokens, !!item.loose);
      if (!item.task) return `<li>${body}</li>\n`;
      const mark = /^\s*\[(.)\]/.exec(item.raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''))?.[1] ?? ' ';
      const checked = mark !== ' ';
      const cleaned = body.replace(/^<input[^>]*>\s*/, '');
      return (
        `<li class="task-list-item${checked ? ' is-checked' : ''}" data-task="${esc(mark)}">` +
        `<input class="task-list-item-checkbox" type="checkbox"${checked ? ' checked' : ''}>${cleaned}</li>\n`
      );
    },
    code({ text, lang }: Tokens.Code) {
      const l = (lang ?? '').trim().split(/\s+/)[0];
      return `<pre><code${l ? ` class="language-${esc(l)}"` : ''}>${esc(text)}</code></pre>\n`;
    },
    link({ href, title, tokens }: Tokens.Link) {
      const text = this.parser.parseInline(tokens);
      const external = /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
      const t = title ? ` title="${esc(title)}"` : '';
      if (external) {
        return `<a class="external-link" href="${esc(href)}"${t} target="_blank" rel="noopener nofollow">${text}</a>`;
      }
      let target = href;
      try {
        target = decodeURI(href);
      } catch {
        /* keep raw */
      }
      return `<a class="internal-link" data-href="${esc(target)}" href="${esc(target)}"${t}>${text}</a>`;
    },
    image({ href, title, text }: Tokens.Image) {
      const external = /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
      if (external) {
        return `<img src="${esc(href)}" alt="${esc(text)}"${title ? ` title="${esc(title)}"` : ''}>`;
      }
      let target = href;
      try {
        target = decodeURI(href);
      } catch {
        /* keep raw */
      }
      // Local image via markdown syntax: resolved like an embed.
      return `<span class="internal-embed" src="${esc(target)}" alt="${esc(text)}"></span>`;
    },
  },
});

/** Strip YAML front matter; returns the body and the raw YAML (if any). */
export function splitFrontmatter(md: string): { yaml: string | null; body: string; bodyLineOffset: number } {
  const m = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(md);
  if (!m) return { yaml: null, body: md, bodyLineOffset: 0 };
  return { yaml: m[1], body: md.slice(m[0].length), bodyLineOffset: m[0].split('\n').length - 1 };
}

export function markdownToHtml(md: string): string {
  return obsidianMarked.parse(md, { async: false }) as string;
}
