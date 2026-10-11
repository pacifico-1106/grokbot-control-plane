/**
 * Tenant isolation via the gateway HTTP path: a valid org-A 社員証 with an
 * AI-supplied conversation.orgId of another org is refused with 403
 * conversation_org_mismatch, identically whether that org exists or not.
 * Only the credential lookup is stubbed; runGatewayInvoke is the real one.
 */
import { expect, mock, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";

const SECRET = "gb_emp_conversation_org_fixture";

mock.module("@/lib/auth/employee-credential", () => ({
  extractEmployeeSecret(req: Request): string | null {
    return /^Bearer\s+(.+)$/i.exec((req.headers.get("authorization") || "").trim())?.[1]?.trim() || null;
  },
  async resolveEmployeeCredential(req: Request) {
    const raw = /^Bearer\s+(.+)$/i.exec((req.headers.get("authorization") || "").trim())?.[1]?.trim();
    if (raw === SECRET) {
      return { ok: true, credential: { employeeId: "emp_comm", credentialId: "cred_comm", orgId: DEMO_ORG.id } };
    }
    return { ok: false, code: "invalid_credential", httpStatus: 401, message: "invalid" };
  },
}));

const { POST } = await import("./route");
const { upsertOrgChannel } = await import("@/lib/data/directory");

function call(orgId: string | undefined, jobId: string) {
  return POST(
    new Request("https://staffpass.test/api/gateway/invoke", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({
        tool: "comm.reply",
        purpose: "comm.internal",
        jobId,
        conversation: { surface: "slack", ...(orgId ? { orgId } : {}), slackChannelId: "C0BHTTPINTERNAL" },
        args: { slackChannelId: "C0BHTTPINTERNAL", text: "本文" },
      }),
    })
  );
}

test("HTTP: conversation.orgId of another org → 403 conversation_org_mismatch (exists vs not: identical)", async () => {
  await upsertOrgChannel({ orgId: "org_tenant_b_http", surface: "slack", externalId: "C0BHTTPINTERNAL", classification: "internal", skipInspect: true });
  const jobId = `job_http_bola_${Date.now()}`;
  const a = await call("org_tenant_b_http", jobId);
  const b = await call("org_tenant_ghost_http", jobId);
  expect(a.status).toBe(403);
  const aBody = await a.json();
  expect(aBody.code).toBe("conversation_org_mismatch");
  expect(b.status).toBe(403);
  expect(await b.json()).toEqual(aBody);
});

test("HTTP 木村 repro: CBINTERNAL internal in B; without orgId denied, with orgId=B refused, nothing posted", async () => {
  await upsertOrgChannel({ orgId: "org_kimura_repro_b", surface: "slack", externalId: "CBINTERNAL", classification: "internal", skipInspect: true });
  const posts: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("chat.postMessage")) posts.push(url);
    return Response.json({ ok: true, channel: "CBINTERNAL", ts: "1.1" });
  }) as typeof fetch;
  try {
    const send = (orgId?: string) =>
      POST(new Request("https://staffpass.test/api/gateway/invoke", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({
          tool: "comm.reply", purpose: "comm.internal", jobId: `job_http_kimura_${Math.random().toString(36).slice(2, 8)}`,
          conversation: { surface: "slack", ...(orgId ? { orgId } : {}), slackChannelId: "CBINTERNAL" },
          args: { slackChannelId: "CBINTERNAL", text: "本文" },
        }),
      }));
    const without = await send();
    expect(without.status).toBe(403);
    expect((await without.json()).code).toBe("egress_denied");
    const withB = await send("org_kimura_repro_b");
    expect(posts.length).toBe(0);
    expect(withB.status).toBe(403);
    expect((await withB.json()).code).toBe("conversation_org_mismatch");
    const withA = await send(DEMO_ORG.id);
    expect(withA.status).toBe(403);
    expect((await withA.json()).code).toBe("egress_denied");
  } finally {
    globalThis.fetch = orig;
  }
});

test("HTTP: same org → unchanged (unregistered channel stays egress_denied)", async () => {
  const res = await call(DEMO_ORG.id, `job_http_same_${Date.now()}`);
  expect(res.status).toBe(403);
  expect((await res.json()).code).toBe("egress_denied");
});
