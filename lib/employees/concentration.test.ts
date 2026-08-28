import { describe, expect, test } from "bun:test";
import { buildConcentration } from "./concentration";
import type { Employee } from "@/lib/types";
import { defaultVoice } from "./voice";

const base: Omit<Employee, "id" | "displayName" | "scopes"> = {
  orgId: "org-a",
  roleLabel: "test",
  jobDescription: "",
  status: "active",
  allowedPurposes: [],
  approvalPolicy: "risk_based",
  sodLevel: "ok",
  actionLimits: {},
  voice: defaultVoice(),
  projectAccess: { mode: "company", projectIds: [] },
  credentialId: null,
  createdAt: "2026-08-26T00:00:00.000Z",
};

describe("permission concentration", () => {
  test("flags an employee holding at least half and multiple domains", () => {
    const report = buildConcentration([
      { ...base, id: "a", displayName: "万能", scopes: ["mail:send", "commerce:order"] },
      { ...base, id: "b", displayName: "更新", scopes: ["files:write"] },
    ]);
    expect(report.orgHighRiskDomainCount).toBe(3);
    expect(report.employees[0].share).toBeCloseTo(2 / 3);
    expect(report.flagged).toEqual(["a"]);
  });
});
