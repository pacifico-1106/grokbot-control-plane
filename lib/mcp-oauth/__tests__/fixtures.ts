/** Shared OAuth test fixtures (memory store + fake employee directory). */
import { createMemoryOAuthStore, type OAuthStore } from "@/lib/data/oauth";
import { mintAccessToken } from "@/lib/mcp-oauth/tokens";

export const ISSUER = "https://staffpass.sealith.com";
export const RESOURCE = `${ISSUER}/api/mcp`;
export const CLAUDE_CLIENT = "https://claude.ai/oauth/mcp-client.json";

export type FakeEmployee = { id: string; orgId: string; status: string; credentialId: string | null; displayName: string; roleLabel?: string };
export const directory = {
  employees: new Map<string, FakeEmployee>(),
  bindings: new Map<string, { status: string; credentialGeneration: number; orgId: string; employeeId: string }>(),
  credentials: new Map<string, { credentialId: string; expiresAt: string | null } | null>(),
  reset() {
    this.employees.clear();
    this.bindings.clear();
    this.credentials.clear();
    this.employees.set("emp_1", { id: "emp_1", orgId: "org_a", status: "active", credentialId: "cred_1", displayName: "営業AI", roleLabel: "営業アシスタント" });
    this.bindings.set("emp_1", { status: "linked", credentialGeneration: 3, orgId: "org_a", employeeId: "emp_1" });
    this.credentials.set("emp_1", { credentialId: "cred_1", expiresAt: null });
  },
};

export async function seedClientAndGrant(store: OAuthStore, overrides: Partial<{ orgId: string; employeeId: string; resource: string; expiresAt: string }> = {}) {
  await store.upsertClient({
    clientId: CLAUDE_CLIENT,
    registrationType: "cimd",
    clientName: "Claude",
    clientUri: null,
    logoUri: null,
    redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    tokenEndpointAuthMethod: "none",
    metadata: {},
    metadataFetchedAt: null,
    metadataExpiresAt: null,
    status: "active",
    createdIpHash: null,
  });
  const grant = await store.createGrant({
    orgId: overrides.orgId ?? "org_a",
    employeeId: overrides.employeeId ?? "emp_1",
    clientId: CLAUDE_CLIENT,
    credentialIdAtGrant: "cred_1",
    grantedByMemberId: "mem_1",
    grantedByEmail: "owner@example.com",
    resource: overrides.resource ?? RESOURCE,
    scope: ["staffpass.employee"],
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 86400_000).toISOString(),
  });
  const at = mintAccessToken();
  await store.createAccessToken({ tokenHash: at.hash, grantId: grant.id, expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  return { grant, accessToken: at.raw, accessHash: at.hash };
}

export function freshStore() {
  return createMemoryOAuthStore();
}
