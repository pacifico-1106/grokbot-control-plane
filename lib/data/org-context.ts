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
      referralCode: DEMO_ORG.referralCode,
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
      referralCode: DEMO_ORG.referralCode,
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

/** Normalize optional partner code (AIC-XXXX). Empty → null. */
export function normalizeReferralCode(
  raw: string | null | undefined
): string | null {
  const t = String(raw || "").trim().toUpperCase();
  if (!t) return null;
  return t;
}

/**
 * Persist referral_code on org when empty (thin tracking).
 * DEMO: store on DEMO_ORG in memory. Production: update orgs if currently null.
 */
export async function setOrgReferralCodeIfEmpty(
  orgId: string,
  raw: string | null | undefined
): Promise<string | null> {
  const code = normalizeReferralCode(raw);
  if (!code) return null;

  if (isDemoMode()) {
    if (!DEMO_ORG.referralCode) DEMO_ORG.referralCode = code;
    return DEMO_ORG.referralCode;
  }

  const admin = createSupabaseAdminClient();
  if (!admin || !orgId) return code;

  const { data } = await admin
    .from("orgs")
    .select("referral_code")
    .eq("id", orgId)
    .maybeSingle();
  const existing = (data as { referral_code?: string | null } | null)
    ?.referral_code;
  if (existing && String(existing).trim()) {
    return String(existing).trim();
  }

  await admin
    .from("orgs")
    .update({
      referral_code: code,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orgId);
  return code;
}
