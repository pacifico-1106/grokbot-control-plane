/**
 * D9: per-config signing secret + payload mode for the approval callback.
 * Behind WEBHOOK_HARDENING_ENABLED (404 when OFF). Authority = same as
 * issuing / rotating a credential (owner/admin + hire_issue_credentials).
 * The secret is returned exactly once (no-store) and never by GET / audit.
 * Demo mode, dummy values.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-notification-key-0123456789abcdef-webhooks";
const { getRuntimeAudit } = await import("@/lib/demo-data");
const settings = await import("@/lib/webhooks/settings");
const { GET, POST } = await import("@/app/api/employees/[id]/webhook-signing/route");

const ctx = (id = "emp_sales") => ({ params: Promise.resolve({ id }) });
const SAME_ORIGIN = { origin: "https://staffpass.test" };
const post = (body: Record<string, unknown>, member = "mem_1", originHeaders: Record<string, string> = SAME_ORIGIN) =>
  new Request("https://staffpass.test/api/employees/emp_sales/webhook-signing", {
    method: "POST", headers: { "content-type": "application/json", "x-member-id": member, ...originHeaders }, body: JSON.stringify(body),
  });
const get = (member = "mem_1") => new Request("https://staffpass.test/api/employees/emp_sales/webhook-signing", { headers: { "x-member-id": member } });

beforeEach(() => { settings.__resetWebhookSettingsForTests(); process.env.WEBHOOK_HARDENING_ENABLED = "true"; });
afterEach(() => { delete process.env.WEBHOOK_HARDENING_ENABLED; });

describe("/api/employees/[id]/webhook-signing", () => {
  test("flag OFF → 404 feature_disabled for GET and POST; nothing stored", async () => {
    delete process.env.WEBHOOK_HARDENING_ENABLED;
    expect((await GET(get(), ctx())).status).toBe(404);
    const res = await POST(post({ action: "mint_callback_secret" }), ctx());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "feature_disabled" });
    process.env.WEBHOOK_HARDENING_ENABLED = "true";
    expect((await (await GET(get(), ctx())).json()).settings.callbackSigning).toBe("none");
  });
  test("authority: admin without hire_issue_credentials / member → 403; unknown employee → 404", async () => {
    for (const m of ["mem_2", "mem_3"]) {
      expect((await POST(post({ action: "mint_callback_secret" }, m), ctx())).status).toBe(403);
      expect((await GET(get(m), ctx())).status).toBe(403);
    }
    expect((await POST(post({ action: "mint_callback_secret" }), ctx("emp_nope"))).status).toBe(404);
    expect((await (await GET(get(), ctx())).json()).settings.callbackSigning).toBe("none");
  });
  test("mint: secret once (no-store), audit + GET carry only a fingerprint prefix", async () => {
    const res = await POST(post({ action: "mint_callback_secret" }), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json() as { ok: boolean; secret: string; fingerprintPrefix: string };
    expect(body.secret).toMatch(/^whsec_/);
    expect(body.fingerprintPrefix).toMatch(/^[0-9a-f]{12}$/);
    const view = await (await GET(get(), ctx())).json() as { settings: Record<string, unknown> };
    expect(view.settings).toEqual({ callbackSigning: "callback_secret", callbackSecretFingerprint: body.fingerprintPrefix, callbackPayload: "minimal" });
    const audit = getRuntimeAudit().find((e) => e.action === "employee.webhook_secret_minted" && e.employeeId === "emp_sales");
    expect(audit?.metadata).toMatchObject({ fingerprintPrefix: body.fingerprintPrefix, target: "approval_callback" });
    expect(JSON.stringify(getRuntimeAudit())).not.toContain(body.secret.slice(6));
    expect(JSON.stringify(view)).not.toContain(body.secret.slice(6));
  });
  test("payload mode: minimal | legacy_full only; audited", async () => {
    expect((await POST(post({ action: "set_callback_payload", mode: "everything" }), ctx())).status).toBe(400);
    const res = await POST(post({ action: "set_callback_payload", mode: "legacy_full" }), ctx());
    expect(await res.json()).toEqual({ ok: true, callbackPayload: "legacy_full" });
    expect(getRuntimeAudit().some((e) => e.action === "employee.webhook_payload_mode_set" && e.metadata?.mode === "legacy_full")).toBe(true);
    expect((await POST(post({ action: "nope" }), ctx())).status).toBe(400);
  });

  test("flag OFF (Kimura #2): set_callback_payload saves (same authz); mint / GET stay 404; audited", async () => {
    delete process.env.WEBHOOK_HARDENING_ENABLED;
    const res = await POST(post({ action: "set_callback_payload", mode: "legacy_full" }), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, callbackPayload: "legacy_full" });
    expect(await settings.getCallbackWebhookConfig("emp_sales", "org_demo")).toMatchObject({ state: "ok", payload: "legacy_full" });
    expect(getRuntimeAudit().some((e) => e.action === "employee.webhook_payload_mode_set" && e.metadata?.mode === "legacy_full" && e.metadata?.flagOn === false)).toBe(true);
    expect((await POST(post({ action: "set_callback_payload", mode: "everything" }), ctx())).status).toBe(400);
    for (const m of ["mem_2", "mem_3"]) {
      expect((await POST(post({ action: "set_callback_payload", mode: "minimal" }, m), ctx())).status).toBe(403);
    }
    expect((await POST(post({ action: "set_callback_payload", mode: "minimal" }), ctx("emp_nope"))).status).toBe(404);
    expect((await POST(post({ action: "mint_callback_secret" }), ctx())).status).toBe(404);
    expect((await POST(post({ action: "nope" }), ctx())).status).toBe(404);
    expect((await GET(get(), ctx())).status).toBe(404);
    expect(await settings.getCallbackWebhookConfig("emp_sales", "org_demo")).toMatchObject({ payload: "legacy_full", secretSource: "none" });
  });
  test("same-origin (Kimura #3): cross-origin / Origin null / no Origin → 403, nothing minted or changed; flag ON and OFF", async () => {
    const auditCount = () => getRuntimeAudit().filter((e) => e.action === "employee.webhook_secret_minted" || e.action === "employee.webhook_payload_mode_set").length;
    const before = auditCount();
    for (const flag of [true, false]) {
      if (flag) process.env.WEBHOOK_HARDENING_ENABLED = "true"; else delete process.env.WEBHOOK_HARDENING_ENABLED;
      for (const hdrs of [{ origin: "https://evil.example" }, { origin: "null" }, {}, { "sec-fetch-site": "cross-site" }, { origin: "https://staffpass.test.evil.example" }]) {
        for (const body of [{ action: "mint_callback_secret" }, { action: "set_callback_payload", mode: "legacy_full" }]) {
          const res = await POST(post(body, "mem_1", hdrs as Record<string, string>), ctx());
          expect(res.status).toBe(403);
          expect(await res.json()).toEqual({ ok: false, error: "forbidden" });
        }
      }
    }
    process.env.WEBHOOK_HARDENING_ENABLED = "true";
    const view = await (await GET(get(), ctx())).json() as { settings: Record<string, unknown> };
    expect(view.settings).toEqual({ callbackSigning: "none", callbackSecretFingerprint: null, callbackPayload: "minimal" });
    expect(auditCount()).toBe(before);
  });
  test("same-origin request works: Origin = request origin, or Sec-Fetch-Site: same-origin without Origin", async () => {
    let res = await POST(post({ action: "mint_callback_secret" }), ctx());
    expect(res.status).toBe(200);
    expect((await res.json() as { secret: string }).secret).toMatch(/^whsec_/);
    res = await POST(post({ action: "set_callback_payload", mode: "legacy_full" }, "mem_1", { "sec-fetch-site": "same-origin" }), ctx());
    expect(res.status).toBe(200);
  });
});
