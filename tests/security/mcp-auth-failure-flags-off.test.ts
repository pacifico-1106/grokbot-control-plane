/**
 * MCP auth-failure audit + 401 Japanese next-step: flags default OFF.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { isMcpAuth401NextStepJaEnabled, isMcpAuthFailureAuditEnabled } from "@/lib/feature-flags";

const FLAGS = ["MCP_AUTH_FAILURE_AUDIT_ENABLED", "MCP_AUTH_401_NEXT_STEP_JA_ENABLED"] as const;
const saved: Record<string, string | undefined> = {};
afterEach(() => {
  for (const k of FLAGS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("FLAGS-OFF REGRESSION: MCP auth-failure flags default OFF", () => {
  test("both flags OFF when unset", () => {
    for (const k of FLAGS) (saved[k] = process.env[k]), delete process.env[k];
    expect(isMcpAuthFailureAuditEnabled()).toBe(false);
    expect(isMcpAuth401NextStepJaEnabled()).toBe(false);
  });
});
