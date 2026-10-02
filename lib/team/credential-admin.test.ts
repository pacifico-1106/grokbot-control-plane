import { expect, test } from "bun:test";
import type { OrgMember } from "@/lib/types";
import { canIssueEmployeeCredentials, CREDENTIAL_ADMIN_REQUIRED_MESSAGE_JA } from "./rbac";

function m(role: OrgMember["role"], caps: OrgMember["capabilities"]): OrgMember {
  return { id: "m", orgId: "o", email: "e@example.com", displayName: "d", role, capabilities: caps, status: "active" } as OrgMember;
}

test("UI gate mirrors the server: owner/admin AND hire_issue_credentials", () => {
  expect(canIssueEmployeeCredentials(m("owner", ["hire_issue_credentials"]))).toBe(true);
  expect(canIssueEmployeeCredentials(m("admin", ["hire_issue_credentials"]))).toBe(true);
  expect(canIssueEmployeeCredentials(m("member", ["hire_issue_credentials"]))).toBe(false);
  expect(canIssueEmployeeCredentials(m("admin", ["view_dashboard"]))).toBe(false);
  expect(canIssueEmployeeCredentials(null)).toBe(false);
  expect(CREDENTIAL_ADMIN_REQUIRED_MESSAGE_JA).toContain("オーナーまたは管理者");
});
