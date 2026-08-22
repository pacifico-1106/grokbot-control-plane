import { NextResponse } from "next/server";
import { assertExecutable, getBinding } from "@/lib/bindings";
import { getRuntimeEmployees } from "@/lib/demo-data";
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

  const decision = assertExecutable(employeeId);
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
        binding: getBinding(employeeId) ?? null,
      },
      { status }
    );
  }

  const tool = body.tool || "tools:ping";
  const purpose = body.purpose || "ops.health";

  if (isCommerceOrder(tool, purpose)) {
    const employee = getRuntimeEmployees().find((e) => e.id === employeeId);
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
      demo: true,
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

  return NextResponse.json({
    ok: true,
    demo: true,
    employeeId,
    agentId: decision.binding.grokBotAgentId,
    generation: decision.binding.credentialGeneration,
    tool,
    purpose,
    result: { pong: true },
    message: "invoke allowed (binding linked + healthy)",
  });
}
