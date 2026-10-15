/**
 * Minimal ZIP local-file reader for Office magic-byte checks and XML text
 * extraction. No full archive parser — only stored / deflated local entries.
 * Never logs entry contents.
 */
import { inflateRawSync } from "node:zlib";

const LOCAL = 0x04034b50;
const MAX_ENTRIES = 64;
const MAX_NAME = 256;
const MAX_UNCOMPRESSED = 2 * 1024 * 1024;

export type ZipEntry = { name: string; data: Buffer };

function u16(buf: Buffer, offset: number): number {
  return buf.readUInt16LE(offset);
}
function u32(buf: Buffer, offset: number): number {
  return buf.readUInt32LE(offset);
}

export function readZipEntries(buf: Buffer): ZipEntry[] {
  const out: ZipEntry[] = [];
  let offset = 0;
  while (offset + 30 <= buf.length && out.length < MAX_ENTRIES) {
    if (u32(buf, offset) !== LOCAL) break;
    const method = u16(buf, offset + 8);
    const compSize = u32(buf, offset + 18);
    const uncompSize = u32(buf, offset + 22);
    const nameLen = u16(buf, offset + 26);
    const extraLen = u16(buf, offset + 28);
    const nameAt = offset + 30;
    const dataAt = nameAt + nameLen + extraLen;
    if (nameLen === 0 || nameLen > MAX_NAME || dataAt + compSize > buf.length) break;
    const name = buf.slice(nameAt, nameAt + nameLen).toString("utf8");
    const compressed = buf.slice(dataAt, dataAt + compSize);
    offset = dataAt + compSize;
    if (uncompSize > MAX_UNCOMPRESSED) continue;
    let data: Buffer;
    try {
      if (method === 0) data = compressed;
      else if (method === 8) data = inflateRawSync(compressed);
      else continue;
    } catch {
      continue;
    }
    out.push({ name, data });
  }
  return out;
}

export function zipHasEntry(buf: Buffer, test: (name: string) => boolean): boolean {
  return readZipEntries(buf).some((e) => test(e.name));
}
