import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { getCurrentOrgId } from "@/lib/auth/session";
import { assertBillingAllows } from "@/lib/billing/entitlements";
import { issueEmployee, runtimeModeLabel } from "@/lib/data";
import { normalizeAllowedAccounts } from "@/lib/employees/allowed-accounts";
import { normalizeSpendLimits } from "@/lib/spend-gate";
import { requireCapability } from "@/lib/team/demo-actor";
import type { AllowedAccount, ApprovalPolicy, EmployeeScope, SpendLimits } from "@/lib/types";

export const runtime = "nodejs";

function issueSecret(): { raw: string; hash: string; prefix: string } {
  const raw = `gb_emp_${randomBytes(8).toString("hex")}_${randomBytes(16).toString("hex")}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash, prefix: raw.slice(0, 14) };
}

/**
 * Confirm Draft → create employee + issue credential.
 * Dual-mode: DEMO in-memory / production Supabase via lib/data.
 */
export async function POST(req: Request) {
  const rawBody = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const gate = requireCapability(
    req,
    "hire_issue_credentials",
    typeof rawBody.actorMemberId === "string" ? rawBody.actorMemberId : null
  );
  if (!gate.ok) return gate.response;
  const body = rawBody as {
    actorMemberId?: string | null;
    displayName?: string;
    roleLabel?: string;
    jobDescription?: string;
    scopes?: string[];
    allowedPurposes?: string[];
    approvalPolicy?: ApprovalPolicy;
    expiresInDays?: number;
    spend?: Partial<SpendLimits> | null;
    allowedAccounts?: AllowedAccount[] | null;
  };

  const displayName = (body.displayName || "").trim();
  const roleLabel = (body.roleLabel || "").trim();
  if (!displayName || !roleLabel) {
    return NextResponse.json({ error: "name_and_role_required" }, { status: 400 });
  }

  const scopes = (body.scopes || []) as EmployeeScope[];
  if (!scopes.length) {
    return NextResponse.json({ error: "scopes_required" }, { status: 400 });
  }

  const hasOrder = scopes.includes("commerce:order");
  const spend = hasOrder ? normalizeSpendLimits(body.spend ?? {}) : null;
  const allowedAccounts = normalizeAllowedAccounts(body.allowedAccounts);

  const secret = issueSecret();
  const expiresInDays = Math.min(365, Math.max(1, body.expiresInDays || 30));
  const expiresAt = new Date(
    Date.now() + expiresInDays * 86400000
  ).toISOString();
  const orgId = await getCurrentOrgId();

  const billingGate = await assertBillingAllows(orgId, "hire");
  if (!billingGate.ok) return billingGate.response;

  try {
    const result = await issueEmployee({
      orgId,
      displayName,
      roleLabel,
      jobDescription: body.jobDescription || "",
      scopes,
      allowedPurposes: body.allowedPurposes || [],
      approvalPolicy: body.approvalPolicy || "risk_based",
      spend,
      allowedAccounts,
      secretHash: secret.hash,
      secretPrefix: secret.prefix,
      expiresAt,
      auditSummary: `${displayName} の社員証を発行`,
    });

    return NextResponse.json({
      ok: true,
      demo: result.demo,
      mode: runtimeModeLabel(),
      employee: result.employee,
      credential: {
        id: result.credentialId,
        prefix: secret.prefix,
        scopes,
        allowedPurposes: body.allowedPurposes || [],
        approvalPolicy: body.approvalPolicy || "risk_based",
        spend,
        allowedAccounts,
        expiresAt,
        secretHashAlgo: "sha256",
        oneTimeSecret: secret.raw,
        secretHash: secret.hash.slice(0, 12) + "…",
      },
      binding: result.binding,
      generation: result.generation,
      notice:
        "この秘密値は一度だけ表示されます。Grok Bot 側の連携設定に貼り付け、安全に保管してください。employeeId は生涯不変です。",
      actorId: gate.actor.id,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "issue_failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
