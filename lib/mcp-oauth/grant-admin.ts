/**
 * Grant administration (design §7, PR-7): list / revoke OAuth connections of an
 * employee, and bulk revoke on terminate or (opt-in, Q3) on credential rotation.
 * All functions are no-ops while MCP_OAUTH_ENABLED is OFF (tables may not exist).
 */
import { appendAuditEvent } from "@/lib/data";
import { getOAuthStore, type OAuthGrantRecord, type OAuthStore } from "@/lib/data/oauth";
import { isMcpOAuthEnabled } from "@/lib/mcp-oauth/config";

export type GrantRevokeReason = "manual" | "terminate" | "rotate";

export type GrantPublicView = {
  id: string;
  clientHost: string;
  status: "active" | "revoked";
  grantedByEmail: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
};

function hostOf(clientId: string): string {
  try {
    return new URL(clientId).host;
  } catch {
    return "dcr";
  }
}

export function grantPublicView(g: OAuthGrantRecord): GrantPublicView {
  return {
    id: g.id,
    clientHost: hostOf(g.clientId),
    status: g.status,
    grantedByEmail: g.grantedByEmail,
    createdAt: g.createdAt,
    lastUsedAt: g.lastUsedAt,
    expiresAt: g.expiresAt,
    revokedAt: g.revokedAt,
    revokeReason: g.revokeReason,
  };
}

export async function listEmployeeGrants(orgId: string, employeeId: string, store: OAuthStore = getOAuthStore()): Promise<GrantPublicView[]> {
  if (!isMcpOAuthEnabled()) return [];
  const rows = await store.listGrantsForEmployee(orgId, employeeId);
  return rows.filter((g) => g.orgId === orgId && g.employeeId === employeeId).map(grantPublicView);
}

/** Revoke one grant; only if it belongs to (orgId, employeeId). Returns null when not found / foreign. */
export async function revokeEmployeeGrant(
  input: { orgId: string; employeeId: string; grantId: string; byEmail: string },
  store: OAuthStore = getOAuthStore()
): Promise<GrantPublicView | null> {
  if (!isMcpOAuthEnabled()) return null;
  const g = await store.getGrant(input.grantId);
  if (!g || g.orgId !== input.orgId || g.employeeId !== input.employeeId) return null;
  const nowIso = new Date().toISOString();
  if (g.status === "active") {
    await store.revokeGrant(g.id, input.byEmail, "manual", nowIso);
    await appendAuditEvent({
      orgId: g.orgId,
      employeeId: g.employeeId,
      credentialId: null,
      actorEmail: input.byEmail,
      action: "oauth.grant_revoked",
      purpose: null,
      summary: `${hostOf(g.clientId)} への接続を取り消し`,
      metadata: { grantId: g.id, clientHost: hostOf(g.clientId), reason: "manual" },
    });
  }
  await store.revokeTokensForGrant(g.id, nowIso);
  const after = await store.getGrant(g.id);
  return after ? grantPublicView(after) : null;
}

/** Bulk revoke (terminate / opt-in rotate). Returns how many active grants were revoked. */
export async function revokeAllEmployeeGrants(
  input: { orgId: string; employeeId: string; byEmail: string; reason: GrantRevokeReason },
  store: OAuthStore = getOAuthStore()
): Promise<number> {
  if (!isMcpOAuthEnabled()) return 0;
  const nowIso = new Date().toISOString();
  const revoked = await store.revokeGrantsForEmployee(input.orgId, input.employeeId, input.byEmail, input.reason, nowIso);
  for (const g of revoked) await store.revokeTokensForGrant(g.id, nowIso);
  if (revoked.length > 0) {
    await appendAuditEvent({
      orgId: input.orgId,
      employeeId: input.employeeId,
      credentialId: null,
      actorEmail: input.byEmail,
      action: "oauth.grant_revoked",
      purpose: null,
      summary: `AI クライアント接続 ${revoked.length} 件を取り消し（${input.reason === "terminate" ? "契約終了" : input.reason === "rotate" ? "社員証の再発行" : "手動"}）`,
      metadata: { grantIds: revoked.map((g) => g.id), clientHosts: revoked.map((g) => hostOf(g.clientId)), reason: input.reason },
    });
  }
  return revoked.length;
}
