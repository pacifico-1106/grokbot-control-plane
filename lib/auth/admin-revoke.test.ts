import { expect, test } from "bun:test";
import { fingerprintSecret } from "@/lib/bindings";
import { DEMO_ORG } from "@/lib/demo-data";
import { DEMO_ADMIN_SECRET, resetDemoAdminAgent } from "@/lib/data/admin-agents";

test("revoked admin secret is 401 on /api/mcp/admin", async () => {
  resetDemoAdminAgent({
    status: "linked",
    credentialFingerprint: fingerprintSecret(DEMO_ADMIN_SECRET),
    credentialGeneration: 2,
  });
  const { resolveAdminCredential } = await import("@/lib/auth/admin-credential");
  const { revokeOrgAdminAgent } = await import("@/lib/data/admin-agents");
  const reqFor = (secret: string) =>
    new Request("https://staffpass.sealith.com/api/mcp/admin", {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

  const before = await resolveAdminCredential(reqFor(DEMO_ADMIN_SECRET));
  expect(before.ok).toBe(true);

  await revokeOrgAdminAgent({ orgId: DEMO_ORG.id });

  const after = await resolveAdminCredential(reqFor(DEMO_ADMIN_SECRET));
  expect(after.ok).toBe(false);
  if (!after.ok) {
    expect(after.httpStatus).toBe(401);
  }

  const { POST } = await import("@/app/api/mcp/admin/route");
  const res = await POST(reqFor(DEMO_ADMIN_SECRET));
  expect(res.status).toBe(401);
});

test("issue after revoke mints a new usable generation", async () => {
  const { revokeOrgAdminAgent, issueOrgAdminAgent, mintAdminSecret, getOrgAdminAgent } = await import(
    "@/lib/data/admin-agents"
  );
  resetDemoAdminAgent({
    status: "linked",
    credentialFingerprint: fingerprintSecret(DEMO_ADMIN_SECRET),
    credentialGeneration: 2,
    grokBotAgentId: "grok_admin_demo",
  });
  await revokeOrgAdminAgent({ orgId: DEMO_ORG.id });
  const revoked = await getOrgAdminAgent(DEMO_ORG.id);
  expect(revoked?.status).toBe("revoked");
  expect(revoked?.credentialFingerprint).toBeNull();

  const secret = mintAdminSecret();
  const issued = await issueOrgAdminAgent({
    orgId: DEMO_ORG.id,
    secretHash: secret.hash,
    secretPrefix: secret.prefix,
  });
  expect(issued.status).not.toBe("revoked");
  expect(issued.credentialGeneration).toBeGreaterThan(2);
  expect(issued.credentialFingerprint).toBe(secret.hash);

  const { resolveAdminCredential } = await import("@/lib/auth/admin-credential");
  const ok = await resolveAdminCredential(
    new Request("https://staffpass.sealith.com/api/mcp/admin", {
      headers: { authorization: `Bearer ${secret.raw}` },
    })
  );
  expect(ok.ok).toBe(true);
});

test("admin MCP does not advertise a revoke tool", async () => {
  const { ADMIN_MCP_TOOL_NAMES } = await import("@/lib/mcp/admin-public");
  expect((ADMIN_MCP_TOOL_NAMES as readonly string[]).some((n) => /revoke/i.test(n))).toBe(false);
  const { ADMIN_MCP_TOOLS } = await import("@/lib/mcp/admin-tools");
  expect(ADMIN_MCP_TOOLS.some((t) => /revoke/i.test(t.name))).toBe(false);
});

test("findAdminAgentByFingerprint returns null for a revoked agent", async () => {
  const fingerprint = fingerprintSecret(DEMO_ADMIN_SECRET);
  resetDemoAdminAgent({
    status: "revoked",
    credentialFingerprint: fingerprint,
    credentialGeneration: 2,
  });
  const { findAdminAgentByFingerprint } = await import("@/lib/data/admin-agents");
  expect(await findAdminAgentByFingerprint(fingerprint)).toBeNull();
});

test("resolveAdminCredential has no unreachable revoked 403 branch", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./admin-credential.ts", import.meta.url), "utf8");
  expect(src).not.toMatch(/httpStatus:\s*403/);
  expect(src).not.toMatch(/code:\s*"revoked"/);
});
