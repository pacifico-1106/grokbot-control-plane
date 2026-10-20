/**
 * HOLD_DENIAL_AUDIT_ENABLED defaults OFF.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { isHoldDenialAuditEnabled } from "@/lib/feature-flags";

const FLAG = "HOLD_DENIAL_AUDIT_ENABLED";
let saved: string | undefined;
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
});

describe("FLAGS-OFF REGRESSION: HOLD_DENIAL_AUDIT_ENABLED defaults OFF", () => {
  test("unset → OFF", () => {
    saved = process.env[FLAG];
    delete process.env[FLAG];
    expect(isHoldDenialAuditEnabled()).toBe(false);
  });
});
