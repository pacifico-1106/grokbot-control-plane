/** STUB (TDD red phase). */
export const SKETCH_SIZE = 128;

export type ReplyFingerprint = {
  bodyHash: string;
  sketch: number[] | null;
  normalizedLength: number;
};

export function normalizeReplyBody(text: string): string {
  return text;
}

export function fingerprintReplyBody(
  _text: string,
  _key: Buffer,
  _minSimilarityChars = 20
): ReplyFingerprint {
  throw new Error("not_implemented");
}

export function sketchSimilarity(_a: number[] | null, _b: number[] | null): number {
  return 0;
}
