import { describe, expect, test } from "bun:test";
import { bindingPublicView, ensureBindingRow } from "../bindings";
import { DEMO_ORG } from "../demo-data";
import { getApprovalById, getApprovalStatusByToken, resolveApproval } from "./approvals";
import { getEmployee } from "./employees";

describe("P0 org-scoped approvals", () => {
  test("getApprovalById refuses id-only lookup", async () => {
    expect(await getApprovalById("apr_1")).toBeNull();
    expect(await getApprovalById("apr_1", null)).toBeNull();
    expect(await getApprovalById("apr_1", "")).toBeNull();
  });

  test("getApprovalById other-org UUID/id is not visible", async () => {
    expect(await getApprovalById("apr_1", "org_other")).toBeNull();
    expect(
      await getApprovalById("apr_1", "00000000-0000-4000-8000-000000000099")
    ).toBeNull();
  });

  test("getApprovalById returns same-org demo row", async () => {
    const row = await getApprovalById("apr_1", DEMO_ORG.id);
    expect(row?.id).toBe("apr_1");
    expect(row?.orgId).toBe(DEMO_ORG.id);
  });

  test("resolveApproval refuses id-only and other-org", async () => {
    expect(await resolveApproval("apr_1", "approved", "tester@example.com")).toBeNull();
    expect(
      await resolveApproval("apr_1", "rejected", "tester@example.com", "org_other")
    ).toBeNull();
  });

  test("signed poll getApprovalStatusByToken stays id+token (no org session)", async () => {
    const row = await getApprovalStatusByToken(
      "apr_1",
      "st_demo_apr1_status_token_aaaaaaaa"
    );
    expect(row?.id).toBe("apr_1");
    expect(row?.status).toBe("pending");
    expect(await getApprovalStatusByToken("apr_1", "wrong-token")).toBeNull();
    expect(
      await getApprovalStatusByToken("", "st_demo_apr1_status_token_aaaaaaaa")
    ).toBeNull();
  });
});

describe("P0 org-scoped employees", () => {
  test("getEmployee requires orgId", async () => {
    expect(await getEmployee("emp_sales")).toBeNull();
    expect(await getEmployee("emp_sales", null)).toBeNull();
  });

  test("getEmployee other-org id is 404-equivalent null", async () => {
    expect(await getEmployee("emp_sales", "org_other")).toBeNull();
    expect(
      await getEmployee("emp_sales", "00000000-0000-4000-8000-000000000099")
    ).toBeNull();
  });

  test("getEmployee same-org demo employee", async () => {
    const emp = await getEmployee("emp_sales", DEMO_ORG.id);
    expect(emp?.id).toBe("emp_sales");
    expect(emp?.orgId).toBe(DEMO_ORG.id);
  });
});

describe("P0 bindingPublicView", () => {
  test("strips credentialFingerprint", () => {
    const binding = ensureBindingRow("emp_sales", DEMO_ORG.id);
    binding.credentialFingerprint = "deadbeef".repeat(8);
    const view = bindingPublicView(binding);
    expect("credentialFingerprint" in view).toBe(false);
    expect(JSON.stringify(view)).not.toContain("deadbeef");
    expect(view.employeeId).toBe("emp_sales");
    expect(view.orgId).toBe(DEMO_ORG.id);
  });
});
