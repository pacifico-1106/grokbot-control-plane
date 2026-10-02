/**
 * /api/mcp credential resolution (design §4).
 * Prefix split: gb_emp_ → existing resolveEmployeeCredential (unchanged);
 * sp_at_ (OAuth ON only) → access token → grant → employee/binding/credential
 * re-checked on EVERY request. Anything else → existing failure path.
 */
import {
  resolveEmployeeCredential,
  type CredentialAuthResult,
  type ResolvedEmployeeCredential,
} from "@/lib/auth/employee-credential";
import { getBinding, getEmployeeById } from "@/lib/data";
import { getOAuthStore } from "@/lib/data/oauth";
import {
  ACCESS_TOKEN_PREFIX,
  OAUTH_SCOPE_EMPLOYEE,
  allowedOAuthResources,
  isMcpOAuthEnabled,
  isOrgAllowedForOAuth,
  protectedResourceMetadataUrl,
} from "@/lib/mcp-oauth/config";
import { getCurrentEmployeeCredential } from "@/lib/mcp-oauth/employee-state";
import { sha256Hex } from "@/lib/mcp-oauth/tokens";

export type McpAuthMethod = "gb_emp" | "oauth";

export type McpResolvedCredential = ResolvedEmployeeCredential & {
  authMethod: McpAuthMethod;
  oauthGrantId?: string;
  oauthClientId?: string;
  oauthClientHost?: string;
};

export type McpAuthResult =
  | { ok: true; credential: McpResolvedCredential }
  | (Extract<CredentialAuthResult, { ok: false }> & { oauthError?: "invalid_token" });

function bearer(req: Request): string | null {
  const m = /^Bearer\s+(.+)$/i.exec((req.headers.get("authorization") || "").trim());
  return m?.[1]?.trim() || null;
}

/** True when the request carries any credential (Authorization or x-staffpass-credential). */
export function hasAnyMcpCredential(req: Request): boolean {
  return Boolean(bearer(req) || (req.headers.get("x-staffpass-credential") || "").trim());
}

function clientHost(clientId: string): string {
  try {
    return new URL(clientId).host;
  } catch {
    return "dcr";
  }
}

const touched = new Map<string, number>();
function shouldTouch(grantId: string, nowMs: number): boolean {
  const last = touched.get(grantId) ?? 0;
  if (nowMs - last < 60_000) return false;
  touched.set(grantId, nowMs);
  if (touched.size > 5000) touched.clear();
  return true;
}

const invalid = (message: string): McpAuthResult => ({
  ok: false,
  code: "invalid_credential",
  message,
  httpStatus: 401,
  oauthError: "invalid_token",
});

export async function resolveOAuthAccessToken(raw: string, now = new Date()): Promise<McpAuthResult> {
  const nowIso = now.toISOString();
  const store = getOAuthStore();
  const tok = await store.getAccessToken(sha256Hex(raw));
  if (!tok || tok.revokedAt || Date.parse(tok.expiresAt) <= now.getTime()) {
    return invalid("access token invalid, expired or revoked");
  }
  const grant = await store.getGrant(tok.grantId);
  if (
    !grant ||
    grant.status !== "active" ||
    Date.parse(grant.expiresAt) <= now.getTime() ||
    !allowedOAuthResources().includes(grant.resource) ||
    !grant.scope.includes(OAUTH_SCOPE_EMPLOYEE)
  ) {
    return invalid("grant revoked, expired or not for this resource");
  }
  if (!isOrgAllowedForOAuth(grant.orgId)) return invalid("organization not enabled for OAuth");

  const employee = await getEmployeeById(grant.employeeId);
  if (!employee || employee.orgId !== grant.orgId || employee.status === "suspended") {
    return { ok: false, code: "employee_not_found", message: "employee not found or suspended (fail-closed)", httpStatus: 401, oauthError: "invalid_token" };
  }
  const binding = (await getBinding(grant.employeeId)) ?? null;
  if (binding?.status === "revoked") {
    return { ok: false, code: "revoked", message: "credential / binding revoked (fail-closed)", httpStatus: 403 };
  }
  const current = await getCurrentEmployeeCredential(grant.employeeId);
  if (!current) return invalid("employee has no active credential (fail-closed)");
  if (current.expiresAt && Date.parse(current.expiresAt) <= now.getTime()) {
    return { ok: false, code: "expired", message: "employee credential expired (fail-closed)", httpStatus: 401, oauthError: "invalid_token" };
  }

  if (shouldTouch(grant.id, now.getTime())) {
    void store.touchGrant(grant.id, nowIso).catch(() => undefined);
  }

  return {
    ok: true,
    credential: {
      employeeId: grant.employeeId,
      orgId: grant.orgId,
      generation: binding?.credentialGeneration ?? 0,
      credentialId: current.credentialId,
      fingerprint: "",
      binding,
      secretPrefix: ACCESS_TOKEN_PREFIX,
      authMethod: "oauth",
      oauthGrantId: grant.id,
      oauthClientId: grant.clientId,
      oauthClientHost: clientHost(grant.clientId),
    },
  };
}

export async function resolveMcpCredential(req: Request): Promise<McpAuthResult> {
  const raw = bearer(req);
  if (raw && raw.startsWith(ACCESS_TOKEN_PREFIX) && isMcpOAuthEnabled()) {
    // x-staffpass-credential never carries OAuth tokens; Authorization header only.
    return resolveOAuthAccessToken(raw);
  }
  const legacy = await resolveEmployeeCredential(req);
  if (!legacy.ok) return legacy;
  return { ok: true, credential: { ...legacy.credential, authMethod: "gb_emp" } };
}

/** RFC 6750 / RFC 9728 challenge. Only used when OAuth is ON. */
export function wwwAuthenticate(opts: { error?: "invalid_token"; description?: string } = {}): string {
  const parts = [`resource_metadata="${protectedResourceMetadataUrl()}"`, `scope="${OAUTH_SCOPE_EMPLOYEE}"`];
  if (opts.error) {
    parts.unshift(`error="${opts.error}"`);
    if (opts.description) parts.splice(1, 0, `error_description="${opts.description.replace(/["\\]/g, "")}"`);
  }
  return `Bearer ${parts.join(", ")}`;
}
