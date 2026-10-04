/**
 * D9: per-config webhook settings (employee_webhook_settings, migration
 * 20261005100000): the callback signing secret (minted here, whsec_ + 32
 * random bytes, stored only as lib/notify/crypto.ts ciphertext + sha256
 * fingerprint) and the callback payload mode (minimal by default,
 * legacy_full = opt-in compatibility). Signing-key order for the callback:
 * dedicated callback secret → existing wake-webhook secret → none.
 * Production mode against a mocked service-role client; dummy values.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { encryptNotificationSecrets } from "@/lib/notify/crypto";

process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-notification-key-0123456789abcdef-webhooks";
type Res = { data: unknown; error: unknown };
let settingsRead: Res | "throw" = { data: null, error: null };
let wakeRead: Res = { data: null, error: null };
let clientAvailable = true;
const writes: Array<{ table: string; op: string; row: Record<string, unknown>; filters: Array<[string, unknown]> }> = [];
let writeError: unknown = null;
function fakeClient() {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = (c: string, v: unknown) => { filters.push([c, v]); return chain; };
      chain.maybeSingle = async () => {
        if (table === "employee_webhook_settings") { if (settingsRead === "throw") throw new Error("fetch failed"); return settingsRead; }
        if (table === "employee_binding_secrets") return wakeRead;
        return { data: null, error: null };
      };
      chain.upsert = async (row: Record<string, unknown>) => { writes.push({ table, op: "upsert", row, filters }); return { error: writeError }; };
      return chain;
    },
  };
}
mock.module("@/lib/supabase", () => ({ createSupabaseAdminClient: () => (clientAvailable ? fakeClient() : null) }));
const saved = { u: process.env.NEXT_PUBLIC_SUPABASE_URL, a: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, s: process.env.SUPABASE_SERVICE_ROLE_KEY };
function prodMode() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://unit-test-project.supabase.invalid";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "unit-test-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "unit-test-service-role-key";
}
function demoMode() { delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
afterAll(() => {
  for (const [k, v] of [["NEXT_PUBLIC_SUPABASE_URL", saved.u], ["NEXT_PUBLIC_SUPABASE_ANON_KEY", saved.a], ["SUPABASE_SERVICE_ROLE_KEY", saved.s]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
const settings = await import("@/lib/webhooks/settings");
const EMP = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  settingsRead = { data: null, error: null }; wakeRead = { data: null, error: null }; clientAvailable = true; writes.length = 0; writeError = null;
  settings.__resetWebhookSettingsForTests();
});

describe("production reads", () => {
  test("no row → defaults (minimal, no dedicated secret) and the wake secret is reused when present", async () => {
    prodMode();
    expect(await settings.getCallbackWebhookConfig(EMP, ORG)).toEqual({ state: "ok", payload: "minimal", signingSecret: null, secretSource: "none" });
    wakeRead = { data: { credentials_ciphertext: encryptNotificationSecrets({ wakeSecret: "sender-key-x" }) }, error: null };
    expect(await settings.getCallbackWebhookConfig(EMP, ORG)).toEqual({ state: "ok", payload: "minimal", signingSecret: "sender-key-x", secretSource: "wake_secret" });
  });
  test("row → its payload mode and decrypted dedicated secret (wins over the wake secret); query scoped to employee AND org", async () => {
    prodMode();
    const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
    settingsRead = { data: { employee_id: EMP, org_id: ORG, callback_payload: "legacy_full", callback_secret_ciphertext: encryptNotificationSecrets({ callbackSigningSecret: secret }) }, error: null };
    wakeRead = { data: { credentials_ciphertext: encryptNotificationSecrets({ wakeSecret: "sender-key-x" }) }, error: null };
    expect(await settings.getCallbackWebhookConfig(EMP, ORG)).toEqual({ state: "ok", payload: "legacy_full", signingSecret: secret, secretSource: "callback_secret" });
  });
  test("fail closed: read error / throw / no client / undecryptable secret / unknown mode → error (the caller does not send)", async () => {
    prodMode();
    settingsRead = { data: null, error: { message: "relation \"employee_webhook_settings\" does not exist" } };
    expect(await settings.getCallbackWebhookConfig(EMP, ORG)).toEqual({ state: "error" });
    settingsRead = "throw";
    expect(await settings.getCallbackWebhookConfig(EMP, ORG)).toEqual({ state: "error" });
    settingsRead = { data: { callback_payload: "minimal", callback_secret_ciphertext: "v1.bad.bad.bad" }, error: null };
    expect(await settings.getCallbackWebhookConfig(EMP, ORG)).toEqual({ state: "error" });
    settingsRead = { data: { callback_payload: "everything", callback_secret_ciphertext: null }, error: null };
    expect(await settings.getCallbackWebhookConfig(EMP, ORG)).toEqual({ state: "error" });
    clientAvailable = false;
    expect(await settings.getCallbackWebhookConfig(EMP, ORG)).toEqual({ state: "error" });
  });
});

describe("minting / payload mode (production writes)", () => {
  test("mint: whsec_ + 32 random bytes, returned once; stored as ciphertext + sha256 fingerprint only", async () => {
    prodMode();
    const out = await settings.mintCallbackSigningSecret(EMP, ORG);
    expect(out.secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(out.secret.slice(6), "base64")).toHaveLength(32);
    expect(out.fingerprint).toBe(createHash("sha256").update(out.secret).digest("hex"));
    expect(writes).toHaveLength(1);
    const row = writes[0].row;
    expect(writes[0].table).toBe("employee_webhook_settings");
    expect(row).toMatchObject({ employee_id: EMP, org_id: ORG, callback_secret_fingerprint: out.fingerprint });
    expect(String(row.callback_secret_ciphertext)).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain(out.secret.slice(6));
    const again = await settings.mintCallbackSigningSecret(EMP, ORG);
    expect(again.secret).not.toBe(out.secret);
  });
  test("mint write error → throws a fixed error (no secret returned)", async () => {
    prodMode();
    writeError = { message: "boom" };
    await expect(settings.mintCallbackSigningSecret(EMP, ORG)).rejects.toThrow("webhook_settings_store_error");
  });
  test("payload mode: only minimal | legacy_full", async () => {
    prodMode();
    await settings.setCallbackPayloadMode(EMP, ORG, "legacy_full");
    expect(writes[0].row).toMatchObject({ employee_id: EMP, org_id: ORG, callback_payload: "legacy_full" });
    await expect(settings.setCallbackPayloadMode(EMP, ORG, "everything" as never)).rejects.toThrow("invalid_callback_payload");
  });
});

describe("demo store", () => {
  test("mint → config uses it; view never contains the secret; payload mode round-trips; orgs are separate", async () => {
    demoMode();
    expect(await settings.getCallbackWebhookConfig(EMP, ORG)).toMatchObject({ state: "ok", payload: "minimal", secretSource: "none" });
    const { secret, fingerprint } = await settings.mintCallbackSigningSecret(EMP, ORG);
    expect(await settings.getCallbackWebhookConfig(EMP, ORG)).toEqual({ state: "ok", payload: "minimal", signingSecret: secret, secretSource: "callback_secret" });
    await settings.setCallbackPayloadMode(EMP, ORG, "legacy_full");
    const view = await settings.getWebhookSettingsView(EMP, ORG);
    expect(view).toEqual({ callbackSigning: "callback_secret", callbackSecretFingerprint: fingerprint.slice(0, 12), callbackPayload: "legacy_full" });
    expect(JSON.stringify(view)).not.toContain(secret.slice(6));
    expect(await settings.getCallbackWebhookConfig(EMP, "33333333-3333-4333-8333-333333333333")).toMatchObject({ state: "ok", payload: "minimal", secretSource: "none" });
  });
});
