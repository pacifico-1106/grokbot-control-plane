import { NextResponse } from "next/server";
import { assertExecutable, getBinding } from "@/lib/bindings";

export const runtime = "nodejs";

/**
 * Fail-closed tool invoke stub.
 * Requires employeeId (body or x-employee-id) with executable binding.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    employeeId?: string;
    tool?: string;
    purpose?: string;
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

  return NextResponse.json({
    ok: true,
    demo: true,
    employeeId,
    agentId: decision.binding.grokBotAgentId,
    generation: decision.binding.credentialGeneration,
    tool: body.tool || "tools:ping",
    purpose: body.purpose || "ops.health",
    result: { pong: true },
    message: "invoke allowed (binding linked + healthy)",
  });
}
