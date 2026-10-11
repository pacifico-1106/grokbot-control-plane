/** 運営からのお知らせ: all six flags default OFF; the sub-flags need their parent flag. */
import { afterEach, describe, expect, test } from "bun:test";
import * as f from "@/lib/operator-notices/flags";

const NAMES = ["OPERATOR_NOTICES_ENABLED", "OPERATOR_NOTICES_PILOT_ORG_IDS", "OPERATOR_NOTICES_WAKE_ENABLED",
  "OPERATOR_NOTICES_TENANT_VIEW_ENABLED", "OPS_FEEDBACK_ENABLED", "OPS_WEEKLY_DIGEST_ENABLED"] as const;
const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
afterEach(() => { for (const n of NAMES) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; } });
const clear = () => { for (const n of NAMES) delete process.env[n]; };

describe("operator notice flags", () => {
  test("unset → everything OFF", () => {
    clear();
    expect([f.isOperatorNoticesEnabled(), f.isOperatorNoticesWakeEnabled(), f.isOperatorNoticesTenantViewEnabled(),
      f.isOpsFeedbackEnabled(), f.isOpsWeeklyDigestEnabled(), f.operatorNoticesEnabledForOrg("org_x")]).toEqual([false, false, false, false, false, false]);
    expect(f.operatorNoticesPilotOrgIds()).toEqual([]);
  });
  test("sub-flags without the parent stay OFF", () => {
    clear();
    process.env.OPERATOR_NOTICES_WAKE_ENABLED = "true";
    process.env.OPERATOR_NOTICES_TENANT_VIEW_ENABLED = "true";
    process.env.OPS_WEEKLY_DIGEST_ENABLED = "true";
    expect([f.isOperatorNoticesWakeEnabled(), f.isOperatorNoticesTenantViewEnabled(), f.isOpsWeeklyDigestEnabled()]).toEqual([false, false, false]);
  });
  test("pilot list limits the org; empty = everyone", () => {
    clear();
    process.env.OPERATOR_NOTICES_ENABLED = "true";
    expect(f.operatorNoticesEnabledForOrg("11111111-1111-4111-8111-111111111111")).toBe(true);
    process.env.OPERATOR_NOTICES_PILOT_ORG_IDS = " 11111111-1111-4111-8111-111111111111 , not a uuid ";
    expect(f.operatorNoticesPilotOrgIds()).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(f.operatorNoticesEnabledForOrg("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(f.operatorNoticesEnabledForOrg("22222222-2222-4222-8222-222222222222")).toBe(false);
  });
});
