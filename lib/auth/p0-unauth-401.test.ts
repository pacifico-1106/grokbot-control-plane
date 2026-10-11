import { describe, expect, mock, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
import { GET as getEmployeeLink } from "../../app/api/employees/[id]/link/route";
import { GET as getGatewayLink } from "../../app/api/gateway/link/route";
import { GET as getTeamMembers } from "../../app/api/team/members/route";
import * as requireOrg from "./require-org";

const { requireOrgSession } = requireOrg;

describe("requireOrgSession", () => {
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
    const res = await getTeamMembers(new Request("http://localhost/api/team/members"));
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

/**
 * SEC1 (2026-10-05): POST /api/trial and POST /api/email were mail relays
 * (any org member, arbitrary recipient, /api/trial put orgName into the
 * subject/body, no rate limit, no audit, 0 UI callers). They are deleted, so
 * both paths must resolve to no App Router handler (= Next.js 404).
 */
const APP_DIR = fileURLToPath(new URL("../../app", import.meta.url));
const HANDLER_FILES = ["route.ts", "route.tsx", "route.js", "route.mjs", "page.tsx", "page.ts", "page.js", "page.jsx"];

function isDir(p: string): boolean {
  return existsSync(p) && statSync(p).isDirectory();
}

/** Every App Router handler file that would serve `segments` (static, [x], [...x], [[...x]], (group)). */
function appRouterHandlersFor(dir: string, segments: readonly string[]): string[] {
  const out: string[] = [];
  const entries = isDir(dir) ? readdirSync(dir) : [];
  if (segments.length === 0) {
    for (const f of HANDLER_FILES) if (existsSync(join(dir, f))) out.push(join(dir, f));
  }
  for (const name of entries) {
    const child = join(dir, name);
    if (!isDir(child)) continue;
    if (/^\(.+\)$/.test(name)) {
      out.push(...appRouterHandlersFor(child, segments)); // route group: no URL segment
    } else if (/^\[\[\.\.\..+\]\]$/.test(name)) {
      out.push(...appRouterHandlersFor(child, [])); // optional catch-all
    } else if (segments.length > 0 && /^\[\.\.\..+\]$/.test(name)) {
      out.push(...appRouterHandlersFor(child, [])); // catch-all
    } else if (segments.length > 0 && /^\[[^.\]]+\]$/.test(name)) {
      out.push(...appRouterHandlersFor(child, segments.slice(1)));
    } else if (segments.length > 0 && name === segments[0]) {
      out.push(...appRouterHandlersFor(child, segments.slice(1)));
    }
  }
  return out;
}

describe("SEC1: mail relay endpoints are gone (404)", () => {
  test("resolver sanity: an existing route resolves", () => {
    expect(appRouterHandlersFor(APP_DIR, ["api", "approvals"]).length).toBeGreaterThan(0);
    expect(appRouterHandlersFor(APP_DIR, ["api", "employees", "emp_x", "link"]).length).toBeGreaterThan(0);
  });

  for (const path of ["/api/trial", "/api/email"]) {
    test(`${path} has no handler → 404`, () => {
      const segments = path.split("/").filter(Boolean);
      expect(appRouterHandlersFor(APP_DIR, segments)).toEqual([]);
      expect(isDir(join(APP_DIR, ...segments))).toBe(false);
    });
  }

  test("middleware does not rewrite / special-case the removed paths", () => {
    const middleware = fileURLToPath(new URL("../../middleware.ts", import.meta.url));
    expect(readFileSync(middleware, "utf8")).not.toMatch(/\/api\/(trial|email)\b/);
  });

  test("the relay-only helper requireAuthenticatedOrg is removed", () => {
    expect("requireAuthenticatedOrg" in requireOrg).toBe(false);
  });

  test("only reviewed routes import the mail helpers directly (fixed / own-signup / Stripe recipients)", () => {
    const routes: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (isDir(p)) walk(p);
        else if (/^route\.(ts|tsx|js|mjs)$/.test(name)) routes.push(p);
      }
    };
    walk(join(APP_DIR, "api"));
    const importers = routes
      .filter((p) => /from\s+["'](@\/lib\/(email|resend)|(\.\.\/)+lib\/(email|resend))["']/.test(readFileSync(p, "utf8")))
      .map((p) => p.slice(APP_DIR.length + 1))
      .sort();
    expect(importers).toEqual([
      // own signup address only, behind Turnstile + signup guard (unauthenticated, pre-login)
      "api/auth/signup/route.ts",
      // fixed ops address (AI_EMP_INQUIRY_NOTIFY_EMAIL)
      "api/lp/ai-employee/inquiry/route.ts",
      // Stripe-signed webhook; recipient = billing customer on file
      "api/webhooks/stripe/route.ts",
    ]);
  });
});
