import { describe, expect, it } from 'vitest';
import { Text } from '@codemirror/state';
import { markdownLanguage } from '@codemirror/lang-markdown';
import type { MarkdownParser } from '@lezer/markdown';
import { scanBlocks } from '../livePreview';
import { obsidianMarkdown } from '../obsidianSyntax';

const parser = (markdownLanguage.parser as MarkdownParser).configure([obsidianMarkdown]);
function nodes(md: string): string[] {
  const out: string[] = [];
  parser.parse(md).iterate({
    enter: (n) => {
      if (n.name !== 'Document' && n.name !== 'Paragraph') out.push(`${n.name}:${md.slice(n.from, n.to)}`);
    },
  });
  return out;
}

describe('Obsidian Markdown syntax', () => {
  it('parses wikilinks, embeds, highlights, tags, math, comments', () => {
    const n = nodes('Siehe [[Epilepsie#Therapie|Therapie]] und ![[bild.png]] ==wichtig== #neuro/epi $x^2$ %%geheim%%');
    expect(n).toContain('WikiLink:[[Epilepsie#Therapie|Therapie]]');
    expect(n).toContain('WikiTarget:Epilepsie#Therapie');
    expect(n).toContain('WikiAlias:Therapie');
    expect(n).toContain('WikiEmbed:![[bild.png]]');
    expect(n).toContain('Highlight:==wichtig==');
    expect(n).toContain('Hashtag:#neuro/epi');
    expect(n).toContain('InlineMath:$x^2$');
    expect(n).toContain('ObsidianComment:%%geheim%%');
  });
  it('ignores the syntax inside code and for prices / numbers', () => {
    const n = nodes('`[[kein Link]]` kostet $5 und $10, Ausgabe #1');
    expect(n.some((x) => x.startsWith('WikiLink'))).toBe(false);
    expect(n.some((x) => x.startsWith('InlineMath'))).toBe(false);
    expect(n.some((x) => x.startsWith('Hashtag'))).toBe(false);
  });
  it('keeps GFM tasks and tables', () => {
    const n = nodes('- [x] erledigt\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
    expect(n.some((x) => x.startsWith('TaskMarker:[x]'))).toBe(true);
    expect(n.some((x) => x.startsWith('Table:'))).toBe(true);
  });
});

describe('Live Preview block scan', () => {
  it('finds front matter, code, math, callouts and tables', () => {
    const md = [
      '---',
      'title: Test',
      '---',
      '# Titel',
      '```dataview',
      'LIST',
      '```',
      'Text',
      '> [!question] Frage',
      '> Antwort',
      '',
      '| a | b |',
      '| --- | :-: |',
      '| 1 | 2 |',
      '$$',
      'x^2',
      '$$',
      '> normales Zitat',
    ].join('\n');
    const doc = Text.of(md.split('\n'));
    const blocks = scanBlocks(doc).map((b) => `${b.kind}@${b.line}:${doc.lineAt(b.to).number}`);
    expect(blocks).toEqual(['frontmatter@1:3', 'code@5:7', 'callout@9:10', 'table@12:14', 'math@15:17']);
  });
  it('an unclosed fence runs to the end; --- later in the note is no front matter', () => {
    const doc = Text.of(['Text', '---', 'a', '---', '```js', 'x']);
    expect(scanBlocks(doc).map((b) => b.kind)).toEqual(['code']);
  });
});
