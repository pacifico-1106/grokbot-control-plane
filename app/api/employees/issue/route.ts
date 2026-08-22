import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { requireCapability } from "@/lib/team/demo-actor";
import { rotateCredential } from "@/lib/bindings";
import { addRuntimeEmployee, DEMO_ORG } from "@/lib/demo-data";
import { normalizeAllowedAccounts } from "@/lib/employees/allowed-accounts";
import { normalizeSpendLimits } from "@/lib/spend-gate";
import type { AllowedAccount, ApprovalPolicy, Employee, EmployeeScope, SpendLimits } from "@/lib/types";

export const runtime = "nodejs";

function issueDemoSecret(): { raw: string; hash: string; prefix: string } {
  const raw = `gb_emp_${randomBytes(8).toString("hex")}_${randomBytes(16).toString("hex")}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash, prefix: raw.slice(0, 14) };
}

/**
 * Confirm Draft → create employee + issue credential.
 * Demo mode: in-memory + one-time secret returned once.
 * Production: hash into credentials.secret_hash via Supabase admin client.
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
  // Fail-closed: order scope without usable spend → still persist null so gate needs_approval.
  const spend = hasOrder ? normalizeSpendLimits(body.spend ?? {}) : null;
  const allowedAccounts = normalizeAllowedAccounts(body.allowedAccounts);

  const secret = issueDemoSecret();
  const employeeId = `emp_${randomBytes(4).toString("hex")}`;
  const credentialId = `cred_${randomBytes(4).toString("hex")}`;
  const expiresInDays = Math.min(365, Math.max(1, body.expiresInDays || 30));

  const employee: Employee = {
    id: employeeId,
    orgId: DEMO_ORG.id,
    displayName,
    roleLabel,
    jobDescription: body.jobDescription || "",
    status: "active",
    scopes,
    allowedPurposes: body.allowedPurposes || [],
    approvalPolicy: body.approvalPolicy || "risk_based",
    spend,
    allowedAccounts,
    credentialId,
    createdAt: new Date().toISOString(),
  };

  addRuntimeEmployee(employee, `${displayName} の社員証を発行`);
  const { binding, generation } = rotateCredential(
    employeeId,
    DEMO_ORG.id,
    secret.hash
  );

  return NextResponse.json({
    ok: true,
    demo: true,
    employee,
    credential: {
      id: credentialId,
      prefix: secret.prefix,
      scopes,
      allowedPurposes: body.allowedPurposes || [],
      approvalPolicy: body.approvalPolicy || "risk_based",
      spend,
      allowedAccounts,
      expiresAt: new Date(Date.now() + expiresInDays * 86400000).toISOString(),
      secretHashAlgo: "sha256",
      // Raw secret shown ONCE — never stored plaintext.
      oneTimeSecret: secret.raw,
      secretHash: secret.hash.slice(0, 12) + "…",
    },
    binding,
    generation,
    notice:
      "この秘密値は一度だけ表示されます。Grok Bot 側の連携設定に貼り付け、安全に保管してください。employeeId は生涯不変です。",
    actorId: gate.actor.id,
  });
}
