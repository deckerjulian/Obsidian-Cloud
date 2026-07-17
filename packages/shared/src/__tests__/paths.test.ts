import { describe, it, expect } from 'vitest';
import { normalizePath, ancestorPaths, parentPath, depthOf, joinPath, isAncestorOrSelf } from '../paths';
import { roleAtLeast, canWrite, canRead, maxRole } from '../roles';

describe('paths', () => {
  it('normalizes slashes and edges', () => {
    expect(normalizePath('/a//b/c/')).toBe('a/b/c');
    expect(normalizePath('a\\b')).toBe('a/b');
    expect(normalizePath('')).toBe('');
  });

  it('computes ancestor paths including root and self', () => {
    expect(ancestorPaths('a/b/c')).toEqual(['', 'a', 'a/b', 'a/b/c']);
    expect(ancestorPaths('a')).toEqual(['', 'a']);
    expect(ancestorPaths('')).toEqual(['']);
  });

  it('parent and depth', () => {
    expect(parentPath('a/b/c')).toBe('a/b');
    expect(parentPath('a')).toBe('');
    expect(depthOf('')).toBe(0);
    expect(depthOf('a/b')).toBe(2);
    expect(joinPath('a/b', 'c')).toBe('a/b/c');
    expect(joinPath('', 'c')).toBe('c');
  });

  it('ancestor checks', () => {
    expect(isAncestorOrSelf('', 'a/b')).toBe(true);
    expect(isAncestorOrSelf('a', 'a/b')).toBe(true);
    expect(isAncestorOrSelf('a/b', 'a/b')).toBe(true);
    expect(isAncestorOrSelf('a/b', 'a')).toBe(false);
    expect(isAncestorOrSelf('a', 'ab/c')).toBe(false);
  });
});

describe('roles', () => {
  it('ranks roles', () => {
    expect(roleAtLeast('owner', 'editor')).toBe(true);
    expect(roleAtLeast('viewer', 'editor')).toBe(false);
    expect(canWrite('editor')).toBe(true);
    expect(canWrite('viewer')).toBe(false);
    expect(canRead('viewer')).toBe(true);
    expect(canRead(null)).toBe(false);
    expect(maxRole('viewer', 'owner')).toBe('owner');
    expect(maxRole(null, 'editor')).toBe('editor');
  });
});
