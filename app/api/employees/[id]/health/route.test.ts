/**
 * POST /api/employees/[id]/health writes the binding (ensure row, status,
 * last_success_at / last_error) → org owner/admin only (木村 review, PR #259).
 * ?forceFail=1 is a demo-only switch: ignored outside demo mode (lib/mode
 * isDemoMode), so nobody can force needs_reauth in production.
 *
 * GET is read-only (木村 2026-10-04): it returns the current binding health and
 * never writes — no ensure row, no success / failure record, no forceFail —
 * even for owners/admins. A missing row is reported as unlinked, not created.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { SessionContext } from "@/lib/auth/session";
import type { OrgMember } from "@/lib/types";

const member = (role: OrgMember["role"]): OrgMember => ({
  id: `m-${role}`,
  orgId: "org-a",
  userId: `u-${role}`,
  email: `${role}@example.com`,
  displayName: role,
  role,
  status: "active",
});
let demo = false;
let session: SessionContext = { demo: false, userId: null, email: null, orgId: null, member: null };
let writes: string[] = [];
const linked = { employeeId: "emp-1", orgId: "org-a", status: "linked", grokBotAgentId: "agent-x", lastSuccessAt: null };
let stored: typeof linked | undefined = linked;

mock.module("@/lib/mode", () => ({
  isDemoMode: () => demo,
  isSupabaseConfigured: () => !demo,
  runtimeModeLabel: () => (demo ? "demo" : "production"),
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
}));
mock.module("@/lib/auth/session", () => ({
  getSessionContext: async () => session,
  getCurrentOrgId: async () => session.orgId,
}));
mock.module("@/lib/data", () => ({
  getEmployee: async (id: string, orgId: string | null) => (id === "emp-1" && orgId === "org-a" ? { id, orgId } : null),
  ensureBindingRow: async () => {
    writes.push("ensure");
    return linked;
  },
  getBinding: async () => stored,
  unlinkedBinding: (employeeId: string, orgId: string) => ({
    employeeId,
    orgId,
    status: "unlinked",
    grokBotAgentId: null,
    lastSuccessAt: null,
  }),
  recordHealthFailure: async (_id: string, reason: string) => {
    writes.push(`failure:${reason}`);
    return { ...linked, status: "needs_reauth" };
  },
  recordHealthSuccess: async () => {
    writes.push("success");
    return linked;
  },
  bindingPublicView: (b: unknown) => b,
  runtimeModeLabel: () => (demo ? "demo" : "production"),
}));
const { GET, POST } = await import("./route");

const ctx = { params: Promise.resolve({ id: "emp-1" }) };
const post = (q = "") => POST(new Request(`http://localhost/api/employees/emp-1/health${q}`, { method: "POST" }), ctx);
const get = (q = "") => GET(new Request(`http://localhost/api/employees/emp-1/health${q}`), ctx);
const as = (role: OrgMember["role"] | null) => {
  session = role
    ? { demo: false, userId: `u-${role}`, email: `${role}@example.com`, orgId: "org-a", member: member(role) }
    : { demo: false, userId: null, email: null, orgId: null, member: null };
};

beforeEach(() => {
  writes = [];
  demo = false;
  stored = linked;
});

test("member session is rejected (403 admin_required) without touching the binding", async () => {
  as("member");
  for (const q of ["", "?forceFail=1"]) {
    const res = await post(q);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("admin_required");
  }
  expect(writes).toEqual([]);
});

test("unauthenticated request is rejected (401) without a write", async () => {
  as(null);
  const res = await post("?forceFail=1");
  expect(res.status).toBe(401);
  expect(writes).toEqual([]);
});

test("production: ?forceFail=1 is ignored — an admin probe records the real result", async () => {
  as("admin");
  for (const q of ["?forceFail=1", "?forceFail=true"]) {
    const res = await post(q);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  }
  expect(writes).toEqual(["ensure", "success", "ensure", "success"]);
});

test("demo mode: ?forceFail=1 still simulates a failure (needs_reauth)", async () => {
  demo = true;
  session = { demo: true, userId: null, email: null, orgId: "org-a", member: null };
  const res = await post("?forceFail=1");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.code).toBe("needs_reauth");
  expect(writes).toEqual(["ensure", "failure:forced_demo_failure"]);
});

test("owner can run the probe", async () => {
  as("owner");
  expect((await post()).status).toBe(200);
  expect(writes).toEqual(["ensure", "success"]);
});

describe("GET is read-only", () => {
  test("member can read the current health; nothing is written", async () => {
    as("member");
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.readOnly).toBe(true);
    expect(body.persisted).toBe(true);
    expect(body.binding.status).toBe("linked");
    expect(writes).toEqual([]);
  });

  test("owner/admin GET never records success / failure", async () => {
    for (const role of ["owner", "admin"] as const) {
      as(role);
      expect((await get()).status).toBe(200);
    }
    expect(writes).toEqual([]);
  });

  test("?forceFail is ignored by GET, even in demo mode", async () => {
    demo = true;
    session = { demo: true, userId: null, email: null, orgId: "org-a", member: null };
    const res = await get("?forceFail=1");
    expect(res.status).toBe(200);
    expect((await res.json()).binding.status).toBe("linked");
    expect(writes).toEqual([]);
  });

  test("missing binding row: reported as unlinked, not created", async () => {
    stored = undefined;
    as("member");
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.persisted).toBe(false);
    expect(body.binding.status).toBe("unlinked");
    expect(writes).toEqual([]);
  });

  test("unauthenticated GET → 401; unknown employee → 404; no write", async () => {
    as(null);
    expect((await get()).status).toBe(401);
    as("member");
    const other = await GET(new Request("http://localhost/api/employees/emp-x/health"), {
      params: Promise.resolve({ id: "emp-x" }),
    });
    expect(other.status).toBe(404);
    expect(writes).toEqual([]);
  });

  test("GET handler does not delegate to POST or call a writer", () => {
    const src = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    const getBody = src.slice(src.indexOf("export async function GET"));
    expect(getBody).not.toMatch(/\bPOST\(|ensureBindingRow|recordHealth(Success|Failure)/);
  });
});
