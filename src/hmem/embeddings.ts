/**
 * A small deterministic embedder.
 *
 * H-MEM's conformance suite does not assert absolute scores, because those
 * depend on the embedder; it asserts the ordering the formula determines. So a
 * local, dependency-free bag-of-words projection is enough here, and it keeps
 * the engine runnable with no network and no model download.
 */

const DIMENSIONS = 128;

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'is', 'are', 'was',
  'were', 'be', 'been', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'about',
  'we', 'i', 'it', 'this', 'that', 'do', 'does', 'did', 'when', 'what',
  'which', 'who', 'how', 'why',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

/** FNV-1a, so the same token always lands in the same dimension. */
function hashToken(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % DIMENSIONS;
}

export function embed(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  const tokens = tokenize(text);
  for (const token of tokens) {
    const index = hashToken(token);
    vector[index] = (vector[index] ?? 0) + 1;
  }
  // L2-normalise so cosine reduces to a dot product.
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}

export function cosine(a: number[] | undefined, b: number[] | undefined): number {
  if (!a || !b) return 0;
  let dot = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) dot += a[i]! * b[i]!;
  return Math.max(0, Math.min(1, dot));
}

/** Jaccard overlap of two token sets. */
export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const value of setA) if (setB.has(value)) shared += 1;
  const union = setA.size + setB.size - shared;
  return union === 0 ? 0 : shared / union;
}

export const clamp01 = (value: number): number =>
  Math.max(0, Math.min(1, value));
