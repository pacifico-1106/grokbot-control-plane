import {
  DEMO_ORG,
  getGatewayStatus,
  setGatewayStatus as setDemoGateway,
} from "../demo-data";
import { isDemoMode } from "../mode";
import { createSupabaseAdminClient } from "../supabase";
import { mapOrgRow, type OrgMeta } from "./mappers";
import type { GatewayLinkStatus } from "../types";

/** Default org for DEMO; in production use session orgId. */
export async function getOrgMeta(orgId?: string | null): Promise<OrgMeta> {
  if (isDemoMode()) {
    return {
      id: DEMO_ORG.id,
      name: DEMO_ORG.name,
      integrationMode: DEMO_ORG.integrationMode,
      gatewayStatus: getGatewayStatus(),
      trialEndsAt: DEMO_ORG.trialEndsAt,
    };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return {
      id: DEMO_ORG.id,
      name: DEMO_ORG.name,
      integrationMode: DEMO_ORG.integrationMode,
      gatewayStatus: DEMO_ORG.gatewayStatus,
      trialEndsAt: DEMO_ORG.trialEndsAt,
    };
  }

  const id = orgId;
  if (!id) {
    throw new Error("org_id_required");
  }

  const { data, error } = await admin
    .from("orgs")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error || !data) {
    throw new Error(error?.message || "org_not_found");
  }
  return mapOrgRow(data as Record<string, unknown>);
}

export async function getGatewayStatusForOrg(
  orgId?: string | null
): Promise<GatewayLinkStatus> {
  if (isDemoMode()) return getGatewayStatus();
  const meta = await getOrgMeta(orgId);
  return meta.gatewayStatus;
}

export async function setGatewayStatusForOrg(
  status: GatewayLinkStatus,
  orgId?: string | null
): Promise<void> {
  if (isDemoMode()) {
    setDemoGateway(status);
    return;
  }
  const admin = createSupabaseAdminClient();
  if (!admin || !orgId) return;
  await admin
    .from("orgs")
    .update({ gateway_status: status, updated_at: new Date().toISOString() })
    .eq("id", orgId);
  await admin.from("gateway_links").upsert({
    org_id: orgId,
    mode: "managed",
    status,
    updated_at: new Date().toISOString(),
  });
}
