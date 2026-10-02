import { NextResponse } from "next/server";
import {
  extractEmployeeSecret,
  resolveEmployeeCredential,
} from "@/lib/auth/employee-credential";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import type { GatewayInvokeRequest } from "@/lib/types";

export const runtime = "nodejs";

/**
 * Fail-closed tool invoke (P0 contract).
 * Requires a 社員証 secret: Bearer gb_emp_… or x-staffpass-credential.
 * x-employee-id / body.employeeId are NOT identity on their own (anyone can
 * send them); when present alongside a credential they must match it.
 * Server-side callers (remote MCP, stuck-watch retry, approvals fulfill) call
 * runGatewayInvoke directly after their own auth and never go through HTTP.
 * Enforcement lives in lib/gateway/invoke (shared with remote MCP).
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as GatewayInvokeRequest;
  const headerId = (req.headers.get("x-employee-id") || "").trim() || undefined;
  const bodyId = (body.employeeId || "").trim() || undefined;

  if (!extractEmployeeSecret(req)) {
    return NextResponse.json(
      {
        ok: false,
        code: "credential_required",
        error: "credential_required",
        message:
          "社員証（Authorization: Bearer gb_emp_… または x-staffpass-credential）が必要です。x-employee-id だけでは実行できません (fail-closed)",
      },
      {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer realm="staffpass-gateway"' },
      }
    );
  }

  const auth = await resolveEmployeeCredential(req);
  if (!auth.ok) {
    return NextResponse.json(
      {
        ok: false,
        code: auth.code,
        error: auth.code,
        message: auth.message,
      },
      { status: auth.httpStatus }
    );
  }
  const employeeId = auth.credential.employeeId;
  const credentialId = auth.credential.credentialId;
  // Reject explicit mismatch with badge identity (fail-closed).
  if (bodyId && bodyId !== employeeId) {
    return NextResponse.json(
      {
        ok: false,
        code: "employee_mismatch",
        error: "employee_mismatch",
        message:
          "body.employeeId does not match Bearer credential employee (fail-closed)",
      },
      { status: 403 }
    );
  }
  if (headerId && headerId !== employeeId) {
    return NextResponse.json(
      {
        ok: false,
        code: "employee_mismatch",
        error: "employee_mismatch",
        message:
          "x-employee-id does not match Bearer credential employee (fail-closed)",
      },
      { status: 403 }
    );
  }

  const result = await runGatewayInvoke({
    employeeId,
    body,
    credentialId,
  });
  return NextResponse.json(result.body, { status: result.httpStatus });
}
