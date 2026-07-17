export interface TextDiff {
  /** Index where the change starts. */
  pos: number;
  /** Number of characters to delete at `pos`. */
  delCount: number;
  /** String to insert at `pos`. */
  insStr: string;
}

/**
 * Minimal single-range diff via common prefix + suffix. Replacing only the
 * changed middle keeps unchanged regions' CRDT identity intact when applied to
 * a Y.Text, so concurrent edits elsewhere are preserved.
 */
export function computeTextDiff(oldStr: string, newStr: string): TextDiff {
  if (oldStr === newStr) return { pos: 0, delCount: 0, insStr: '' };

  const min = Math.min(oldStr.length, newStr.length);
  let prefix = 0;
  while (prefix < min && oldStr[prefix] === newStr[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < min - prefix &&
    oldStr[oldStr.length - 1 - suffix] === newStr[newStr.length - 1 - suffix]
  ) {
    suffix++;
  }

  return {
    pos: prefix,
    delCount: oldStr.length - prefix - suffix,
    insStr: newStr.slice(prefix, newStr.length - suffix),
  };
}
