import { rejectUnauthorizedCron } from "@/lib/security/cron-secret";
import { sendTenantDigests } from "@/lib/notify/channels";
import { isCredentialAutoRenewEnabled, isCredentialExpiryNoticeEnabled } from "@/lib/feature-flags";
import { jsonUtf8 } from "@/lib/http/json-utf8";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const rejected = rejectUnauthorizedCron(req);
  if (rejected) return rejected;

  const results = await sendTenantDigests();
  const body: Record<string, unknown> = {
    ok: results.every((result) => result.ok || result.skipped),
    deliveries: results.length,
    failed: results.filter((result) => !result.ok && !result.skipped).length,
  };
  // CREDENTIAL_EXPIRY_NOTICE_ENABLED (default OFF): 社員証 pre-expiry notice.
  // Isolated: a notice failure never changes the digest result. Counts only.
  if (isCredentialExpiryNoticeEnabled()) {
    try {
      const { runCredentialExpiryNotices } = await import("@/lib/employees/credential-expiry-notice");
      body.credentialExpiryNotice = await runCredentialExpiryNotices();
    } catch {
      body.credentialExpiryNotice = { error: "credential_expiry_notice_failed" };
    }
  }
  if (isCredentialAutoRenewEnabled()) {
    try {
      const { expireOverlappedOldCredentials } = await import("@/lib/employees/credential-auto-renew-overlap");
      body.credentialAutoRenewOverlap = await expireOverlappedOldCredentials();
    } catch {
      body.credentialAutoRenewOverlap = { error: "credential_auto_renew_overlap_failed" };
    }
  }
  return jsonUtf8(body);
}
