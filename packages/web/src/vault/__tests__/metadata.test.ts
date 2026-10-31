import { describe, expect, it } from 'vitest';
import { parseMetadata, getAllTags } from '../metadata';
import { LinkResolver, parseLinktext } from '../linkResolver';

const NOTE = `---
tags: [neuro, epilepsie]
aliases: Status
quelle: "[[Leitlinie Status]]"
---
# Status epilepticus

Siehe [[Lorazepam|Benzodiazepine]] und [[Notfälle#Status]] #Prüfung/wichtig.
\`[[nicht im Code]]\`

- Erstlinie ^erst
  - [ ] Lorazepam 4 mg
  - [x] Zugang
- Zweitlinie

> [!question]- Frage
> Welche Dosis? [[Dosierung]]

![[bild.png|300]]

\`\`\`dataview
LIST FROM "x"
\`\`\`
`;

describe('parseMetadata', () => {
  const m = parseMetadata(NOTE);
  it('parses front matter + position', () => {
    expect(m.frontmatter).toEqual({ tags: ['neuro', 'epilepsie'], aliases: 'Status', quelle: '[[Leitlinie Status]]' });
    expect(m.frontmatterPosition?.end.line).toBe(4);
    expect(m.frontmatterLinks?.[0]).toMatchObject({ key: 'quelle', link: 'Leitlinie Status' });
  });
  it('finds headings, links (not in code), embeds, tags', () => {
    expect(m.headings).toEqual([expect.objectContaining({ heading: 'Status epilepticus', level: 1 })]);
    expect(m.links?.map((l) => [l.link, l.displayText])).toEqual([
      ['Lorazepam', 'Benzodiazepine'],
      ['Notfälle#Status', 'Notfälle#Status'],
      ['Dosierung', 'Dosierung'],
    ]);
    expect(m.embeds?.map((e) => e.link)).toEqual(['bild.png']);
    expect(m.tags?.map((t) => t.tag)).toEqual(['#Prüfung/wichtig']);
    expect(getAllTags(m)).toEqual(['#Prüfung/wichtig', '#neuro', '#epilepsie']);
  });
  it('builds list items with parents, tasks and block ids', () => {
    const items = m.listItems!;
    expect(items).toHaveLength(4);
    const [root, t1, t2, root2] = items;
    expect(root.parent).toBeLessThan(0);
    expect(root.id).toBe('erst');
    expect(t1.parent).toBe(root.position.start.line);
    expect(t1.task).toBe(' ');
    expect(t2.task).toBe('x');
    expect(root2.parent).toBe(root.parent);
    expect(m.blocks?.erst).toBeDefined();
  });
  it('classifies sections', () => {
    expect(m.sections?.map((s) => s.type)).toEqual([
      'yaml', 'heading', 'paragraph', 'list', 'callout', 'paragraph', 'code',
    ]);
  });
  it('positions links by line/col/offset', () => {
    const l = m.links![0];
    const lines = NOTE.split('\n');
    expect(lines[l.position.start.line].slice(l.position.start.col, l.position.end.col)).toBe(
      '[[Lorazepam|Benzodiazepine]]',
    );
    expect(NOTE.slice(l.position.start.offset, l.position.end.offset)).toBe('[[Lorazepam|Benzodiazepine]]');
  });
});

describe('LinkResolver', () => {
  const r = new LinkResolver([
    { path: 'A/Note.md' },
    { path: 'B/Note.md' },
    { path: 'B/Sub/Deep.md' },
    { path: 'img/bild.png' },
    { path: 'Top.md' },
  ]);
  it('resolves by name, preferring the source folder', () => {
    expect(r.resolve('Note', 'B/x.md')?.path).toBe('B/Note.md');
    expect(r.resolve('Note', 'A/x.md')?.path).toBe('A/Note.md');
    expect(r.resolve('note', 'Top.md')?.path).toBe('A/Note.md');
  });
  it('resolves exact and partial paths and attachments', () => {
    expect(r.resolve('B/Sub/Deep', 'Top.md')?.path).toBe('B/Sub/Deep.md');
    expect(r.resolve('Sub/Deep', 'Top.md')?.path).toBe('B/Sub/Deep.md');
    expect(r.resolve('bild.png', 'Top.md')?.path).toBe('img/bild.png');
    expect(r.resolve('Missing', 'Top.md')).toBeNull();
  });
  it('splits subpaths', () => {
    expect(parseLinktext('Note#Head')).toEqual({ path: 'Note', subpath: '#Head' });
    expect(parseLinktext('Note#^blk')).toEqual({ path: 'Note', subpath: '#^blk' });
  });
});
