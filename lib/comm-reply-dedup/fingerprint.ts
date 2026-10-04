/**
 * Body fingerprints for duplicate-reply prevention. Only these leave the
 * process: a keyed HMAC-SHA256 of the normalized body and a keyed MinHash
 * sketch (128 × int32) of its character 3-grams. Neither reveals the text
 * without the server-side key; the body itself is never stored or logged.
 */
import { createHmac } from "node:crypto";

export const SKETCH_SIZE = 128;
const SHINGLE = 3;

export type ReplyFingerprint = {
  bodyHash: string;
  /** null when the body is too short for a meaningful similarity estimate. */
  sketch: number[] | null;
  normalizedLength: number;
};

/**
 * NFKC (width), lower case, Slack link markup → URL, then drop whitespace,
 * punctuation, symbols and control / format characters.
 */
export function normalizeReplyBody(text: string): string {
  let s = (text || "").normalize("NFKC").toLowerCase();
  s = s.replace(/<((?:https?|mailto):[^|>\s]+)\|[^>]*>/g, "$1").replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1");
  return s.replace(/[\s\p{P}\p{S}\p{C}]+/gu, "");
}

function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const seedCache = new WeakMap<Buffer, Uint32Array>();
function seedsFor(key: Buffer): Uint32Array {
  const cached = seedCache.get(key);
  if (cached) return cached;
  const seeds = new Uint32Array(SKETCH_SIZE);
  for (let i = 0; i < SKETCH_SIZE; i += 8) {
    const block = createHmac("sha256", key).update(`sketch-seed:${i}`).digest();
    for (let j = 0; j < 8 && i + j < SKETCH_SIZE; j++) seeds[i + j] = block.readUInt32BE(j * 4);
  }
  seedCache.set(key, seeds);
  return seeds;
}

function sketchOf(normalized: string, key: Buffer): number[] {
  const chars = Array.from(normalized);
  const shingles = new Set<string>();
  for (let i = 0; i + SHINGLE <= chars.length; i++) shingles.add(chars.slice(i, i + SHINGLE).join(""));
  const seeds = seedsFor(key);
  const mins = new Array<number>(SKETCH_SIZE).fill(0xffffffff);
  for (const shingle of shingles) {
    const base = createHmac("sha256", key).update(`shingle:${shingle}`).digest().readUInt32BE(0);
    for (let i = 0; i < SKETCH_SIZE; i++) {
      const v = fmix32((base ^ seeds[i]) >>> 0);
      if (v < mins[i]) mins[i] = v;
    }
  }
  // Signed int32 so the values fit Postgres `integer[]`.
  return mins.map((v) => v | 0);
}

export function fingerprintReplyBody(text: string, key: Buffer, minSimilarityChars = 20): ReplyFingerprint {
  const normalized = normalizeReplyBody(text);
  const length = Array.from(normalized).length;
  return {
    bodyHash: createHmac("sha256", key).update(`body:${normalized}`).digest("hex"),
    sketch: length >= Math.max(minSimilarityChars, SHINGLE) ? sketchOf(normalized, key) : null,
    normalizedLength: length,
  };
}

/** Estimated Jaccard similarity of the 3-gram sets (fraction of equal positions). */
export function sketchSimilarity(a: number[] | null, b: number[] | null): number {
  if (!a || !b || a.length !== SKETCH_SIZE || b.length !== SKETCH_SIZE) return 0;
  let equal = 0;
  for (let i = 0; i < SKETCH_SIZE; i++) if (a[i] === b[i]) equal++;
  return equal / SKETCH_SIZE;
}

export type FingerprintMatch = { match: "exact" | "similar"; similarity: number };

/**
 * The duplicate criterion, shared by duplicate suppression and superseding:
 * same keyed body hash, or (threshold set, both sketches present) sketch
 * similarity ≥ threshold. threshold null = exact mode.
 */
export function compareFingerprints(
  a: Pick<ReplyFingerprint, "bodyHash" | "sketch">,
  b: Pick<ReplyFingerprint, "bodyHash" | "sketch">,
  threshold: number | null
): FingerprintMatch | null {
  if (a.bodyHash === b.bodyHash) return { match: "exact", similarity: 1 };
  if (threshold == null || !a.sketch || !b.sketch) return null;
  const similarity = sketchSimilarity(a.sketch, b.sketch);
  return similarity >= threshold ? { match: "similar", similarity } : null;
}
