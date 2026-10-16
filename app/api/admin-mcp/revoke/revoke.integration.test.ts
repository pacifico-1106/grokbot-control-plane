/**
 * Integration: POST /api/admin-mcp/revoke without mocking audit / agent helpers.
 * Demo session is always the org owner.
 */
import { beforeEach, expect, test } from "bun:test";
import { fingerprintSecret } from "@/lib/bindings";
import { DEMO_ORG, getRuntimeAudit } from "@/lib/demo-data";
import {
  DEMO_ADMIN_SECRET,
  getOrgAdminAgent,
  resetDemoAdminAgent,
  revokeOrgAdminAgent,
} from "@/lib/data/admin-agents";

const { POST } = await import("./route");

function call(opts: { headers?: Record<string, string>; body?: unknown } = {}) {
  return POST(
    new Request("https://staffpass.test/api/admin-mcp/revoke", {
      method: "POST",
      headers: {
        origin: "https://staffpass.test",
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
        ...(opts.headers || {}),
      },
      body: JSON.stringify(opts.body ?? {}),
    })
  );
}

beforeEach(() => {
  resetDemoAdminAgent({
    status: "linked",
    credentialFingerprint: fingerprintSecret(DEMO_ADMIN_SECRET),
    credentialGeneration: 4,
  });
});

test("owner revoke writes admin.revoke through real helpers", async () => {
  const before = getRuntimeAudit().filter((e) => e.action === "admin.revoke").length;
  const res = await call({ body: { reason: "key leaked" } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok?: boolean; generation?: number };
  expect(body.ok).toBe(true);
  expect(body.generation).toBe(4);
  const agent = await getOrgAdminAgent(DEMO_ORG.id);
  expect(agent?.status).toBe("revoked");
  expect(agent?.credentialFingerprint).toBeNull();
  const rows = getRuntimeAudit().filter((e) => e.action === "admin.revoke");
  expect(rows.length).toBeGreaterThan(before);
  const row = rows[0];
  expect(row.metadata?.actorKind).toBe("human");
  expect(row.metadata?.generation).toBe(4);
  expect(row.metadata?.reason).toBe("key leaked");
  expect(JSON.stringify(row.metadata)).not.toContain(fingerprintSecret(DEMO_ADMIN_SECRET));
});

test("alreadyRevoked backfills admin.revoke when that generation has none", async () => {
  resetDemoAdminAgent({
    status: "linked",
    credentialFingerprint: fingerprintSecret(DEMO_ADMIN_SECRET),
    credentialGeneration: 7,
  });
  await revokeOrgAdminAgent({ orgId: DEMO_ORG.id });
  const before = getRuntimeAudit().filter(
    (e) => e.action === "admin.revoke" && e.metadata?.generation === 7
  ).length;
  expect(before).toBe(0);
  const res = await call();
  expect(res.status).toBe(200);
  expect(((await res.json()) as { alreadyRevoked?: boolean }).alreadyRevoked).toBe(true);
  const rows = getRuntimeAudit().filter(
    (e) => e.action === "admin.revoke" && e.metadata?.generation === 7
  );
  expect(rows.length).toBeGreaterThan(0);
});
