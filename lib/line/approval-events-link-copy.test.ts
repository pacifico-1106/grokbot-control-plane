import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

describe("L1: approver link fail copy is opaque when limits flag is ON", () => {
  test("approval-events uses one fail reply behind LINE_LINK_CODE_LIMITS_ENABLED", () => {
    const src = readFileSync(join(process.cwd(), "lib/line/approval-events.ts"), "utf8");
    expect(src).toMatch(/isLineLinkCodeLimitsEnabled/);
    expect(src).toMatch(/LINE_CONVERSATION_LINK_FAIL_JA|LINE_APPROVER_LINK_FAIL_JA/);
    expect(src).toMatch(/bound\.messageJa/);
  });
});
