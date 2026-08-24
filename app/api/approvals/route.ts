import { NextResponse } from "next/server";
import { getCurrentOrgId } from "@/lib/auth/session";
import {
  getDemoApprovalsBackend,
  isDurableDemoApprovalsStore,
  listApprovals,
  runtimeModeLabel,
} from "@/lib/data";
import { isDemoMode } from "@/lib/mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List approvals for Approvals UI polling (DEMO cross-refresh). */
export async function GET() {
  const orgId = await getCurrentOrgId();
  const approvals = await listApprovals(orgId);
  return NextResponse.json({
    ok: true,
    mode: runtimeModeLabel(),
    demo: isDemoMode(),
    demoStore: isDemoMode() ? getDemoApprovalsBackend() : null,
    durable: isDemoMode() ? isDurableDemoApprovalsStore() : true,
    approvals,
  });
}
