import { describe, it, expect } from 'vitest';
import { computeTextDiff } from '../textDiff';

function apply(oldStr: string, d: { pos: number; delCount: number; insStr: string }): string {
  return oldStr.slice(0, d.pos) + d.insStr + oldStr.slice(d.pos + d.delCount);
}

describe('computeTextDiff', () => {
  const cases: [string, string][] = [
    ['', ''],
    ['', 'hello'],
    ['hello', ''],
    ['hello world', 'hello brave world'],
    ['the quick brown fox', 'the quick red fox'],
    ['abc', 'abc'],
    ['prefix', 'prefixing'],
    ['indented', 'reindented'],
    ['aaa', 'aXa'],
    ['line1\nline2\n', 'line1\nLINE2\n'],
  ];

  it.each(cases)('reconstructs %j -> %j', (oldStr, newStr) => {
    expect(apply(oldStr, computeTextDiff(oldStr, newStr))).toBe(newStr);
  });

  it('produces an empty diff for identical strings', () => {
    expect(computeTextDiff('same', 'same')).toEqual({ pos: 0, delCount: 0, insStr: '' });
  });

  it('only touches the changed middle (insertion)', () => {
    expect(computeTextDiff('hello world', 'hello brave world')).toEqual({
      pos: 6,
      delCount: 0,
      insStr: 'brave ',
    });
  });

  it('only touches the changed middle (replacement)', () => {
    expect(computeTextDiff('the quick brown fox', 'the quick red fox')).toEqual({
      pos: 10,
      delCount: 5,
      insStr: 'red',
    });
  });
});
