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
 * Prefers Bearer gb_emp_… / x-staffpass-credential when present;
 * falls back to x-employee-id / body.employeeId for legacy Bot wiring.
 * Enforcement lives in lib/gateway/invoke (shared with remote MCP).
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as GatewayInvokeRequest;
  const headerId = (req.headers.get("x-employee-id") || "").trim() || undefined;
  const bodyId = (body.employeeId || "").trim() || undefined;

  const hasSecret = Boolean(extractEmployeeSecret(req));
  let employeeId = bodyId || headerId || "";
  let credentialId: string | null = null;

  if (hasSecret) {
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
    employeeId = auth.credential.employeeId;
    credentialId = auth.credential.credentialId;
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
  }

  const result = await runGatewayInvoke({
    employeeId,
    body,
    credentialId,
  });
  return NextResponse.json(result.body, { status: result.httpStatus });
}
