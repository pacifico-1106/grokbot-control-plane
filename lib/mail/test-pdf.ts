/** Tiny valid-magic PDF for tests (no secrets). */
export function minimalPdf(extra = ""): Buffer {
  return Buffer.from(`%PDF-1.4\n1 0 obj<<>>endobj\n${extra}\n%%EOF\n`);
}
