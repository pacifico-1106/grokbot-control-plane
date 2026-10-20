/**
 * POST /api/mcp/employee/credential/claim — R8 gen1 one-time pickup.
 * CREDENTIAL_AUTO_RENEW_GEN1_HTTP_ENABLED (default OFF) → 404.
 * Old gb_emp_ only. Failures share one body. Never log the plaintext 社員証.
 */
import {
  extractEmployeeSecret,
  resolveEmployeeCredential,
} from "@/lib/auth/employee-credential";
import { claimCredentialGen1Http } from "@/lib/employees/credential-auto-renew-gen1";
import { isCredentialAutoRenewEnabled, isCredentialAutoRenewOnForOrg } from "@/lib/employees/credential-auto-renew";
import { isCredentialAutoRenewGen1HttpEnabled } from "@/lib/feature-flags";
import { jsonUtf8 } from "@/lib/http/json-utf8";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const DENY_BODY = { ok: false, error: "not_found" } as const;

function deny() {
  return jsonUtf8(DENY_BODY, { status: 404, headers: NO_STORE });
}

export async function POST(req: Request) {
  try {
    if (!isCredentialAutoRenewGen1HttpEnabled() || !isCredentialAutoRenewEnabled()) {
      return deny();
    }
    const raw = extractEmployeeSecret(req);
    if (!raw || !raw.startsWith("gb_emp_")) {
      return deny();
    }
    const auth = await resolveEmployeeCredential(req);
    if (!auth.ok) return deny();
    const { orgId, employeeId, credentialId } = auth.credential;
    if (!orgId || !employeeId || !credentialId || !isCredentialAutoRenewOnForOrg(orgId)) {
      return deny();
    }
    const issued = await claimCredentialGen1Http({
      orgId,
      employeeId,
      oldCredentialId: credentialId,
    });
    if (!issued.ok) return deny();
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
    return deny();
  }
}
