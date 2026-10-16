import { afterEach, describe, expect, test } from "bun:test";
import {
  isOperatorNoticesEnabled,
  isOperatorNoticesEnabledForOrg,
  isOperatorNoticesTenantViewEnabled,
  isOperatorNoticesWakeEnabled,
  isOpsFeedbackEnabled,
  isOpsWeeklyDigestEnabled,
  operatorNoticesPilotOrgIds,
} from "@/lib/feature-flags";

const KEYS = [
  "OPERATOR_NOTICES_ENABLED",
  "OPERATOR_NOTICES_PILOT_ORG_IDS",
  "OPERATOR_NOTICES_WAKE_ENABLED",
  "OPERATOR_NOTICES_TENANT_VIEW_ENABLED",
  "OPS_FEEDBACK_ENABLED",
  "OPS_WEEKLY_DIGEST_ENABLED",
] as const;
const saved: Record<string, string | undefined> = {};

function clear() {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
}
function restore() {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

afterEach(restore);

describe("operator-notice flags default OFF", () => {
  test("unset env → every flag false; empty pilot list", () => {
    clear();
    expect(isOperatorNoticesEnabled()).toBe(false);
    expect(isOperatorNoticesWakeEnabled()).toBe(false);
    expect(isOperatorNoticesTenantViewEnabled()).toBe(false);
    expect(isOpsFeedbackEnabled()).toBe(false);
    expect(isOpsWeeklyDigestEnabled()).toBe(false);
    expect(operatorNoticesPilotOrgIds()).toEqual([]);
    expect(isOperatorNoticesEnabledForOrg("org_x")).toBe(false);
  });

  test("truthy strings turn OPERATOR_NOTICES_ENABLED on; pilot restricts orgs", () => {
    clear();
    for (const v of ["true", "1", "on", "enabled"]) {
      process.env.OPERATOR_NOTICES_ENABLED = v;
      expect(isOperatorNoticesEnabled()).toBe(true);
    }
    process.env.OPERATOR_NOTICES_ENABLED = "true";
    process.env.OPERATOR_NOTICES_PILOT_ORG_IDS = " org_a , org_b ";
    expect(operatorNoticesPilotOrgIds()).toEqual(["org_a", "org_b"]);
    expect(isOperatorNoticesEnabledForOrg("org_a")).toBe(true);
    expect(isOperatorNoticesEnabledForOrg("org_c")).toBe(false);
    expect(isOperatorNoticesEnabledForOrg(null)).toBe(false);
  });
});
