/**
 * D9: per-config settings for the approval.resolved callback
 * (employee_webhook_settings, migration 20261005100000; one row per employee =
 * per callbackUrl config; RLS on, no policy, service_role only).
 *
 * - callback_payload: "minimal" (default; ids + status) | "legacy_full"
 *   (opt-in compatibility: today's body incl. title / summary / approver
 *   email / purpose / revision note). Only read with WEBHOOK_HARDENING_ENABLED;
 *   with the flag OFF the callback is sent exactly as today.
 * - callback signing secret: minted here (whsec_ + 32 random bytes), returned
 *   once, stored only as lib/notify/crypto.ts ciphertext (AES-256-GCM,
 *   NOTIFICATION_CONFIG_ENCRYPTION_KEY) + sha256 fingerprint.
 * - Signing-key order for the callback: minted callback secret → the existing
 *   wake-webhook secret (employee_binding_secrets, same encryption) → none.
 * Reads that fail (DB error, no client, undecryptable secret) return
 * { state: "error", reason } and the caller does not send (fail closed). This
 * includes the wake-secret fallback (readWakeWebhookSecretStrict): a transient
 * read error must never turn into an unsigned callback. Only a genuinely
 * absent secret means unsigned. A missing settings row means defaults.
 * The payload mode can be stored while the flag is OFF (no delivery effect).
 */
import { createHash, randomBytes } from "node:crypto";
import { readWakeWebhookSecretStrict } from "@/lib/data/bindings";
import { isDemoMode } from "@/lib/mode";
import { decryptNotificationSecrets, encryptNotificationSecrets } from "@/lib/notify/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase";

export const CALLBACK_PAYLOAD_MODES = ["minimal", "legacy_full"] as const;
export type CallbackPayloadMode = (typeof CALLBACK_PAYLOAD_MODES)[number];
export type CallbackSecretSource = "callback_secret" | "wake_secret" | "none";
export type CallbackConfigErrorReason =
  | "settings_read_error"
  | "callback_secret_undecryptable"
  | "wake_secret_read_error"
  | "wake_secret_undecryptable";
export type CallbackWebhookConfig =
  | { state: "ok"; payload: CallbackPayloadMode; signingSecret: string | null; secretSource: CallbackSecretSource }
  | { state: "error"; reason: CallbackConfigErrorReason };

/** Wake-secret fallback, strict: error → reason, absent → "", present → secret. */
async function wakeFallback(employeeId: string): Promise<{ ok: true; secret: string } | { ok: false; reason: CallbackConfigErrorReason }> {
  const r = await readWakeWebhookSecretStrict(employeeId);
  if (r.state === "error") return { ok: false, reason: r.reason === "undecryptable" ? "wake_secret_undecryptable" : "wake_secret_read_error" };
  return { ok: true, secret: r.state === "ok" ? r.secret : "" };
}

type Row = { payload: CallbackPayloadMode; secretCiphertext: string | null; secretFingerprint: string | null };
const demoRows = new Map<string, Row>();
let failureForTests = false;
const key = (employeeId: string, orgId: string) => `${orgId}\n${employeeId}`;

export function __resetWebhookSettingsForTests(): void { demoRows.clear(); failureForTests = false; }
/** Test seam: simulate an unreadable settings table (fail-closed path). */
export function __setWebhookSettingsFailureForTests(v: boolean): void { failureForTests = v; }

const isMode = (v: unknown): v is CallbackPayloadMode => typeof v === "string" && (CALLBACK_PAYLOAD_MODES as readonly string[]).includes(v);

async function readRow(employeeId: string, orgId: string): Promise<{ ok: true; row: Row | null } | { ok: false }> {
  if (failureForTests) return { ok: false };
  if (isDemoMode()) return { ok: true, row: demoRows.get(key(employeeId, orgId)) ?? null };
  try {
    const db = createSupabaseAdminClient();
    if (!db) return { ok: false };
    const { data, error } = await db
      .from("employee_webhook_settings")
      .select("employee_id, org_id, callback_payload, callback_secret_ciphertext, callback_secret_fingerprint")
      .eq("employee_id", employeeId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (error) return { ok: false };
    if (!data) return { ok: true, row: null };
    const d = data as Record<string, unknown>;
    if (!isMode(d.callback_payload)) return { ok: false };
    return {
      ok: true,
      row: {
        payload: d.callback_payload,
        secretCiphertext: d.callback_secret_ciphertext ? String(d.callback_secret_ciphertext) : null,
        secretFingerprint: d.callback_secret_fingerprint ? String(d.callback_secret_fingerprint) : null,
      },
    };
  } catch {
    return { ok: false };
  }
}

/** Settings the hardened callback needs. Never throws. */
export async function getCallbackWebhookConfig(employeeId: string, orgId: string): Promise<CallbackWebhookConfig> {
  const read = await readRow(employeeId, orgId);
  if (!read.ok) return { state: "error", reason: "settings_read_error" };
  const payload = read.row?.payload ?? "minimal";
  if (read.row?.secretCiphertext) {
    try {
      const secret = decryptNotificationSecrets(read.row.secretCiphertext).callbackSigningSecret?.trim() || "";
      if (!secret) return { state: "error", reason: "callback_secret_undecryptable" };
      return { state: "ok", payload, signingSecret: secret, secretSource: "callback_secret" };
    } catch {
      return { state: "error", reason: "callback_secret_undecryptable" };
    }
  }
  const wake = await wakeFallback(employeeId);
  if (!wake.ok) return { state: "error", reason: wake.reason };
  return wake.secret
    ? { state: "ok", payload, signingSecret: wake.secret, secretSource: "wake_secret" }
    : { state: "ok", payload, signingSecret: null, secretSource: "none" };
}

async function upsert(employeeId: string, orgId: string, patch: Partial<Row>): Promise<void> {
  if (isDemoMode()) {
    const cur = demoRows.get(key(employeeId, orgId)) ?? { payload: "minimal", secretCiphertext: null, secretFingerprint: null };
    demoRows.set(key(employeeId, orgId), { ...cur, ...patch });
    return;
  }
  const db = createSupabaseAdminClient();
  if (!db) throw new Error("webhook_settings_store_error");
  const row: Record<string, unknown> = { employee_id: employeeId, org_id: orgId, updated_at: new Date().toISOString() };
  if (patch.payload !== undefined) row.callback_payload = patch.payload;
  if (patch.secretCiphertext !== undefined) row.callback_secret_ciphertext = patch.secretCiphertext;
  if (patch.secretFingerprint !== undefined) row.callback_secret_fingerprint = patch.secretFingerprint;
  const { error } = await db.from("employee_webhook_settings").upsert(row, { onConflict: "employee_id" });
  if (error) throw new Error("webhook_settings_store_error");
}

/** Mints (or rotates) the callback signing secret. The plaintext is returned once and never stored. */
export async function mintCallbackSigningSecret(employeeId: string, orgId: string): Promise<{ secret: string; fingerprint: string }> {
  const secret = `whsec_${randomBytes(32).toString("base64")}`;
  const fingerprint = createHash("sha256").update(secret, "utf8").digest("hex");
  await upsert(employeeId, orgId, {
    secretCiphertext: encryptNotificationSecrets({ callbackSigningSecret: secret }),
    secretFingerprint: fingerprint,
  });
  return { secret, fingerprint };
}

export async function setCallbackPayloadMode(employeeId: string, orgId: string, mode: CallbackPayloadMode): Promise<void> {
  if (!isMode(mode)) throw new Error("invalid_callback_payload");
  await upsert(employeeId, orgId, { payload: mode });
}

/** Secret-free view for the admin API (fingerprint prefix only). */
export async function getWebhookSettingsView(employeeId: string, orgId: string): Promise<{
  callbackSigning: CallbackSecretSource;
  callbackSecretFingerprint: string | null;
  callbackPayload: CallbackPayloadMode;
} | null> {
  const read = await readRow(employeeId, orgId);
  if (!read.ok) return null;
  const hasOwn = Boolean(read.row?.secretCiphertext);
  let wake = "";
  if (!hasOwn) {
    const w = await wakeFallback(employeeId);
    if (!w.ok) return null; // never show a false "none" when the wake secret cannot be read
    wake = w.secret;
  }
  return {
    callbackSigning: hasOwn ? "callback_secret" : wake ? "wake_secret" : "none",
    callbackSecretFingerprint: hasOwn && read.row?.secretFingerprint ? read.row.secretFingerprint.slice(0, 12) : null,
    callbackPayload: read.row?.payload ?? "minimal",
  };
}
