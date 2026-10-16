import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { readZipEntries, zipHasEntry } from "./zip-peek";

function localEntry(opts: {
  name: string;
  compressed: Buffer;
  uncompSize: number;
  method: number;
}): Buffer {
  const name = Buffer.from(opts.name, "utf8");
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(opts.method, 8);
  header.writeUInt32LE(opts.compressed.length, 18);
  header.writeUInt32LE(opts.uncompSize, 22);
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, name, opts.compressed]);
}

describe("readZipEntries", () => {
  test("reads a stored office-like entry", () => {
    const data = Buffer.from("<?xml version=\"1.0\"?><Types/>");
    const buf = localEntry({
      name: "[Content_Types].xml",
      compressed: data,
      uncompSize: data.length,
      method: 0,
    });
    expect(zipHasEntry(buf, (n) => n === "[Content_Types].xml")).toBe(true);
    expect(readZipEntries(buf)[0]?.data.equals(data)).toBe(true);
  });

  test("does not inflate a zip-bomb that lies about uncompSize", () => {
    const raw = Buffer.alloc(3 * 1024 * 1024, 0x41);
    const compressed = deflateRawSync(raw);
    expect(compressed.length).toBeLessThan(64 * 1024);
    const buf = localEntry({
      name: "xl/sharedStrings.xml",
      compressed,
      uncompSize: 100,
      method: 8,
    });
    const entries = readZipEntries(buf);
    expect(entries.every((e) => e.data.length <= 2 * 1024 * 1024)).toBe(true);
    expect(entries.some((e) => e.data.length === raw.length)).toBe(false);
  });
});
