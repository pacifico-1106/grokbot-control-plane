import { describe, expect, mock, test } from "bun:test";

const state = {
  orgId: null as string | null,
  userId: null as string | null,
};

mock.module("./session", () => ({
  getCurrentOrgId: async () => state.orgId,
  getSessionContext: async () => ({
    demo: !state.userId,
    userId: state.userId,
    email: state.userId ? "owner@example.com" : null,
    orgId: state.orgId,
    member: null,
  }),
}));

import { GET as getApprovals } from "../../app/api/approvals/route";
import { GET as getApprovalStatus } from "../../app/api/approvals/status/route";
import { POST as postEmail } from "../../app/api/email/route";
import { GET as getEmployeeLink } from "../../app/api/employees/[id]/link/route";
import { GET as getGatewayLink } from "../../app/api/gateway/link/route";
import { GET as getTeamMembers } from "../../app/api/team/members/route";
import { POST as postTrial } from "../../app/api/trial/route";
import { requireAuthenticatedOrg, requireOrgSession } from "./require-org";

describe("requireOrgSession / requireAuthenticatedOrg", () => {
  test("no org → 401", async () => {
    state.orgId = null;
    state.userId = null;
    const gate = await requireOrgSession();
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.response.status).toBe(401);
  });

  test("org present → ok", async () => {
    state.orgId = "org_demo";
    state.userId = null;
    const gate = await requireOrgSession();
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.orgId).toBe("org_demo");
  });

  test("email/trial helper refuses DEMO synthetic session", async () => {
    state.orgId = "org_demo";
    state.userId = null;
    const gate = await requireAuthenticatedOrg();
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.response.status).toBe(401);
  });

  test("email/trial helper allows Auth user + org", async () => {
    state.orgId = "org_live";
    state.userId = "user_1";
    const gate = await requireAuthenticatedOrg();
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.orgId).toBe("org_live");
  });
});

describe("unauthenticated API 401s", () => {
  test("GET /api/approvals without session → 401", async () => {
    state.orgId = null;
    state.userId = null;
    const res = await getApprovals();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("auth_required");
  });

  test("GET /api/team/members without session → 401", async () => {
    state.orgId = null;
    state.userId = null;
    const res = await getTeamMembers();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("auth_required");
  });

  test("GET /api/gateway/link without session/org → 401", async () => {
    state.orgId = null;
    state.userId = null;
    const res = await getGatewayLink();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("auth_required");
  });

  test("POST /api/email without Auth org → 401 (no Resend)", async () => {
    state.orgId = null;
    state.userId = null;
    const res = await postEmail(
      new Request("http://localhost/api/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "welcome", to: "attacker@example.com" }),
      })
    );
    expect(res.status).toBe(401);
  });

  test("POST /api/email DEMO synthetic org still 401", async () => {
    state.orgId = "org_demo";
    state.userId = null;
    const res = await postEmail(
      new Request("http://localhost/api/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "welcome", to: "attacker@example.com" }),
      })
    );
    expect(res.status).toBe(401);
  });

  test("POST /api/trial without Auth org → 401", async () => {
    state.orgId = null;
    state.userId = null;
    const form = new FormData();
    form.set("email", "attacker@example.com");
    form.set("orgName", "evil");
    const res = await postTrial(
      new Request("http://localhost/api/trial", { method: "POST", body: form })
    );
    expect(res.status).toBe(401);
  });

  test("GET /api/employees/[id]/link without session → 401", async () => {
    state.orgId = null;
    state.userId = null;
    const res = await getEmployeeLink(new Request("http://localhost/api/employees/emp_sales/link"), {
      params: Promise.resolve({ id: "emp_sales" }),
    });
    expect(res.status).toBe(401);
  });

  test("GET /api/employees/[id]/link other-org UUID → 404", async () => {
    state.orgId = "org_other";
    state.userId = "user_1";
    const res = await getEmployeeLink(
      new Request("http://localhost/api/employees/emp_sales/link"),
      { params: Promise.resolve({ id: "emp_sales" }) }
    );
    expect(res.status).toBe(404);
  });
});

describe("signed poll stays public-ish", () => {
  test("GET /api/approvals/status without id+token → 400 (not 401)", async () => {
    const res = await getApprovalStatus(
      new Request("http://localhost/api/approvals/status")
    );
    expect(res.status).toBe(400);
  });

  test("GET /api/approvals/status with valid demo token works unauthenticated", async () => {
    state.orgId = null;
    state.userId = null;
    const res = await getApprovalStatus(
      new Request(
        "http://localhost/api/approvals/status?id=apr_1&token=st_demo_apr1_status_token_aaaaaaaa"
      )
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.approvalId).toBe("apr_1");
    expect(body.status).toBe("pending");
  });
});
