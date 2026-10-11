import { publicApproval } from "@/lib/approvals/public";
import { requireOrgSession } from "@/lib/auth/require-org";
import {
  getDemoApprovalsBackend,
  isDurableDemoApprovalsStore,
  listApprovals,
  runtimeModeLabel,
} from "@/lib/data";
import { isDemoMode } from "@/lib/mode";
import { jsonUtf8 } from "@/lib/http/json-utf8";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List approvals for Approvals UI polling (DEMO cross-refresh). */
export async function GET() {
  const gate = await requireOrgSession();
  if (!gate.ok) return gate.response;

  const approvals = await listApprovals(gate.orgId);
  return jsonUtf8({
    ok: true,
    mode: runtimeModeLabel(),
    demo: isDemoMode(),
    demoStore: isDemoMode() ? getDemoApprovalsBackend() : null,
    durable: isDemoMode() ? isDurableDemoApprovalsStore() : true,
    approvals: approvals.map(publicApproval),
  });
}
