import { NextResponse } from "next/server";
import { getCurrentOrgId } from "@/lib/auth/session";
import {
  assertExecutable,
  getBinding,
  getEmployee,
  runtimeModeLabel,
} from "@/lib/data";
import { evaluateSpend } from "@/lib/spend-gate";

export const runtime = "nodejs";

function isCommerceOrder(tool?: string, purpose?: string): boolean {
  const t = (tool || "").toLowerCase();
  const p = (purpose || "").toLowerCase();
  return (
    t === "commerce.order" ||
    t === "commerce:order" ||
    t.includes("commerce.order") ||
    p === "commerce.order" ||
    p === "commerce:order"
  );
}

/**
 * Fail-closed tool invoke stub.
 * Requires employeeId (body or x-employee-id) with executable binding.
 * commerce.order → spend gate (missing limits ⇒ needs_approval).
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    employeeId?: string;
    tool?: string;
    purpose?: string;
    amountJpy?: number;
    isFirstOrder?: boolean;
    spentTodayJpy?: number;
    spentThisMonthJpy?: number;
  };
  const headerId = req.headers.get("x-employee-id") || undefined;
  const employeeId = (body.employeeId || headerId || "").trim();

  if (!employeeId) {
    return NextResponse.json(
      {
        ok: false,
        code: "unbound",
        error: "employee_id_required",
        message: "employeeId required; refuse invoke (fail-closed)",
      },
      { status: 401 }
    );
  }

  const decision = await assertExecutable(employeeId);
  if (!decision.ok) {
    const status =
      decision.code === "not_found" || decision.code === "unbound"
        ? 401
        : 403;
    return NextResponse.json(
      {
        ok: false,
        code: decision.code,
        error: decision.code,
        message: decision.message,
        binding: (await getBinding(employeeId)) ?? null,
      },
      { status }
    );
  }

  const tool = body.tool || "tools:ping";
  const purpose = body.purpose || "ops.health";

  const orgId = await getCurrentOrgId();

  if (isCommerceOrder(tool, purpose)) {
    const employee = await getEmployee(employeeId, orgId);
    if (!employee) {
      return NextResponse.json(
        {
          ok: false,
          code: "not_found",
          error: "employee_not_found",
          message: "employee not found for spend gate",
        },
        { status: 401 }
      );
    }

    if (!employee.scopes.includes("commerce:order")) {
      return NextResponse.json(
        {
          ok: false,
          code: "scope_denied",
          error: "commerce_order_scope_required",
          message: "commerce:order スコープがありません",
          spend: { decision: "deny", reason: "scope_denied" },
        },
        { status: 403 }
      );
    }

    const amountJpy =
      body.amountJpy == null ? Number.NaN : Number(body.amountJpy);
    const spend = evaluateSpend({
      amountJpy,
      limits: employee.spend,
      approvalPolicy: employee.approvalPolicy,
      isFirstOrder: body.isFirstOrder,
      spentTodayJpy: body.spentTodayJpy,
      spentThisMonthJpy: body.spentThisMonthJpy,
    });

    if (spend.decision !== "allow") {
      const status = spend.decision === "deny" ? 403 : 402;
      return NextResponse.json(
        {
          ok: false,
          code: spend.decision,
          error: spend.reason,
          message: spend.message,
          spend,
          employeeId,
          tool,
          purpose,
        },
        { status }
      );
    }

    return NextResponse.json({
      ok: true,
      demo: runtimeModeLabel() === "demo",
      mode: runtimeModeLabel(),
      employeeId,
      agentId: decision.binding.grokBotAgentId,
      generation: decision.binding.credentialGeneration,
      tool,
      purpose,
      spend,
      result: { ordered: true, amountJpy },
      message: "commerce.order allowed (spend gate passed)",
    });
  }

  const employee = await getEmployee(employeeId, orgId);
  const isBrowserUse =
    (tool || "").toLowerCase().includes("browser") ||
    (purpose || "").toLowerCase().includes("browser") ||
    tool === "browser:use";

  const warnings: string[] = [];
  if (isBrowserUse) {
    if (!employee?.scopes.includes("browser:use")) {
      return NextResponse.json(
        {
          ok: false,
          code: "scope_denied",
          error: "browser_use_scope_required",
          message: "browser:use スコープがありません",
        },
        { status: 403 }
      );
    }
    const accounts = employee.allowedAccounts ?? [];
    if (!accounts.length) {
      warnings.push(
        "allowed_accounts_missing: 許可外部アカウント未設定。ライブセッション照合は不完全なため、ポリシー・監査・Managed確認を併用してください。"
      );
    } else {
      warnings.push(
        "browser_identity_check_partial: 実行時のブラウザID照合はスタブ段階です。社員証の許可IDと目視／監査で補完します。"
      );
    }
  }

  return NextResponse.json({
    ok: true,
    demo: runtimeModeLabel() === "demo",
      mode: runtimeModeLabel(),
    employeeId,
    agentId: decision.binding.grokBotAgentId,
    generation: decision.binding.credentialGeneration,
    tool,
    purpose,
    result: { pong: true },
    warnings: warnings.length ? warnings : undefined,
    allowedAccounts: isBrowserUse ? employee?.allowedAccounts ?? [] : undefined,
    message: warnings.length
      ? "invoke allowed with browser policy warnings"
      : "invoke allowed (binding linked + healthy)",
  });
}
