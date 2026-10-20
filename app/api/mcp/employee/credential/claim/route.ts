/**
 * POST /api/mcp/employee/credential/claim — R8 gen1 one-time pickup.
 * CREDENTIAL_AUTO_RENEW_GEN1_HTTP_ENABLED (default OFF) → 404.
 * Old gb_emp_ only. Failures share one body. Never log the plaintext 社員証.
 */
import {
  extractEmployeeSecret,
  resolveEmployeeCredential,
} from "@/lib/auth/employee-credential";
import { appendAuditEvent } from "@/lib/data/audit";
import { abortMintedCredentialRenewal } from "@/lib/data/credential-renewals";
import { touchCredentialLastUsed } from "@/lib/data/credential-last-used";
import { claimCredentialGen1Http } from "@/lib/employees/credential-auto-renew-gen1";
import { isCredentialAutoRenewEnabled, isCredentialAutoRenewOnForOrg } from "@/lib/employees/credential-auto-renew";
import { isCredentialAutoRenewGen1HttpEnabled } from "@/lib/feature-flags";
import { jsonUtf8 } from "@/lib/http/json-utf8";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const NO_STORE = {
  "Cache-Control": "no-store, private, no-cache, must-revalidate",
  Pragma: "no-cache",
} as const;
const DENY_BODY = { ok: false, error: "not_found" } as const;

function deny() {
  return jsonUtf8(DENY_BODY, { status: 404, headers: NO_STORE });
}

async function auditDenied(input: { orgId: string; employeeId?: string; code: string }): Promise<void> {
  await appendAuditEvent({
    orgId: input.orgId,
    employeeId: input.employeeId ?? null,
    credentialId: null,
    action: "credential.renew_claim_denied",
    purpose: "admin.policy",
    summary: `社員証の更新の受け取りを拒否（${input.code}）`,
    metadata: { code: input.code, employeeId: input.employeeId ?? null },
  }).catch(() => undefined);
}

export async function POST(req: Request) {
  let minted: { orgId: string; employeeId: string; renewalId: string; token: string; newCredentialId: string } | null =
    null;
  try {
    if (!isCredentialAutoRenewGen1HttpEnabled() || !isCredentialAutoRenewEnabled()) {
      return deny();
    }
    const raw = extractEmployeeSecret(req);
    if (!raw || !raw.startsWith("gb_emp_")) {
      return deny();
    }
    const auth = await resolveEmployeeCredential(req, { touchLastUsed: false });
    if (!auth.ok) {
      if (auth.orgId) {
        await auditDenied({ orgId: auth.orgId, employeeId: auth.employeeId, code: auth.code });
      }
      return deny();
    }
    const { orgId, employeeId, credentialId } = auth.credential;
    if (!orgId || !employeeId || !credentialId || !isCredentialAutoRenewOnForOrg(orgId)) {
      if (orgId) await auditDenied({ orgId, employeeId, code: "not_claimable" });
      return deny();
    }
    const issued = await claimCredentialGen1Http({
      orgId,
      employeeId,
      oldCredentialId: credentialId,
    });
    if (!issued.ok) return deny();
    minted = {
      orgId,
      employeeId,
      renewalId: issued.renewalId,
      token: issued.abortToken,
      newCredentialId: issued.newCredentialId,
    };
    void touchCredentialLastUsed(credentialId);
    return jsonUtf8(
      {
        ok: true,
        credential: issued.secret.raw,
        generation: issued.generation,
        expiresAt: issued.expiresAt,
        overlapUntil: issued.overlapUntil,
      },
      { headers: NO_STORE }
    );
  } catch {
    if (minted) {
      await abortMintedCredentialRenewal({
        id: minted.renewalId,
        orgId: minted.orgId,
        token: minted.token,
        newCredentialId: minted.newCredentialId,
      }).catch(() => false);
      await auditDenied({ orgId: minted.orgId, employeeId: minted.employeeId, code: "mint_delivery_failed" });
    }
    return deny();
  }
}
