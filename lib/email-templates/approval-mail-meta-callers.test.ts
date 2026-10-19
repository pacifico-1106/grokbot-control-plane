/**
 * Callers must pass meta (kind + id) into approval mail.
 * invoke.ts kind is opts.tool only (never purpose); empty tool → fixed "ticket".
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("approval mail callers pass meta", () => {
  test("invoke.ts kind is opts.tool only; empty tool uses fixed ticket", () => {
    const src = read("lib/gateway/invoke.ts");
    const start = src.indexOf("sendApprovalNeededEmail(");
    expect(start).toBeGreaterThan(-1);
    const snippet = src.slice(start, start + 280);
    expect(snippet).not.toContain("opts.purpose");
    expect(snippet).toMatch(/kind:\s*opts\.tool\s*\|\|\s*"ticket"/);
    expect(snippet).toMatch(/id:\s*createdApproval\?\.id/);
  });

  test("other sendApprovalNeededEmail / sendApprovalNotification callers pass kind and id", () => {
    const files = [
      "lib/admin-mcp/queue.ts",
      "lib/external-contract-card/queue-card-setup.ts",
      "lib/external-contract-card/queue-portal-link.ts",
      "lib/approvals/resolve-side-effects.ts",
    ];
    for (const file of files) {
      const src = read(file);
      expect(src, file).toMatch(/kind:\s/);
      expect(src, file).toMatch(/id:\s/);
    }
  });
});
