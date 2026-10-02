/**
 * MCP client-compat surface for OAuth (PR-8). Everything here is only used
 * when MCP_OAUTH_ENABLED is ON; flag OFF → callers never reach this module
 * and responses stay byte-identical.
 *
 * - securitySchemes on tools/list entries (OpenAI Apps / ChatGPT connectors)
 * - `_meta["mcp/www_authenticate"]` on tool-level auth errors so clients that
 *   only see the JSON-RPC body (no HTTP headers) can still start OAuth
 * - staffpass_profile: read-only, stable opaque id (no PII beyond the
 *   employee display name / role label the org already shows the client)
 */
import { createHash } from "node:crypto";
import { OAUTH_SCOPE_EMPLOYEE, oauthIssuer, protectedResourceMetadataUrl } from "@/lib/mcp-oauth/config";
import { wwwAuthenticate } from "@/lib/mcp-oauth/resource-server";

export const STAFFPASS_PROFILE_TOOL_NAME = "staffpass_profile";

export const STAFFPASS_PROFILE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "Stable opaque profile id (per org+employee). Not a DB id." },
    displayName: { type: "string" },
    roleLabel: { type: "string" },
    org: {
      type: "object",
      properties: { name: { type: ["string", "null"] } },
      required: ["name"],
      additionalProperties: false,
    },
    authMethod: { type: "string", enum: ["oauth", "gb_emp"] },
  },
  required: ["id", "displayName", "roleLabel", "org", "authMethod"],
  additionalProperties: false,
} as const;

export const STAFFPASS_PROFILE_TOOL_DEF = {
  name: STAFFPASS_PROFILE_TOOL_NAME,
  description:
    "Read-only profile of the connected Staffpass AI employee (stable opaque id, display name, role, org). No secrets, no credential material.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    additionalProperties: false,
  },
  outputSchema: STAFFPASS_PROFILE_OUTPUT_SCHEMA,
};

export type StaffpassProfile = {
  id: string;
  displayName: string;
  roleLabel: string;
  org: { name: string | null };
  authMethod: "oauth" | "gb_emp";
};

/** sp_prof_ + 32 hex of sha256("staffpass-profile|org|employee"). Deterministic, non-reversible. */
export function stableProfileId(orgId: string, employeeId: string): string {
  const h = createHash("sha256").update(`staffpass-profile|${orgId}|${employeeId}`).digest("hex");
  return `sp_prof_${h.slice(0, 32)}`;
}

export function buildProfile(input: {
  orgId: string;
  employeeId: string;
  displayName: string;
  roleLabel: string;
  orgName: string | null;
  authMethod: "oauth" | "gb_emp";
}): StaffpassProfile {
  return {
    id: stableProfileId(input.orgId, input.employeeId),
    displayName: input.displayName,
    roleLabel: input.roleLabel,
    org: { name: input.orgName },
    authMethod: input.authMethod,
  };
}

export function profileToolResult(profile: StaffpassProfile) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(profile, null, 2) }],
    structuredContent: profile,
    _meta: {
      "openai/profile": {
        id: profile.id,
        name: profile.displayName,
        role: profile.roleLabel,
        org: profile.org.name,
      },
    },
  };
}

export function oauthSecuritySchemes(): Array<Record<string, unknown>> {
  return [{ type: "oauth2", scopes: [OAUTH_SCOPE_EMPLOYEE] }];
}

/** Adds securitySchemes (top-level + _meta mirror) and the profile outputSchema. */
export function decorateToolsForOAuth(tools: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return tools.map((t) => {
    const schemes = oauthSecuritySchemes();
    const meta = { ...((t._meta as Record<string, unknown> | undefined) ?? {}), securitySchemes: schemes };
    const out: Record<string, unknown> = { ...t, securitySchemes: schemes, _meta: meta };
    if (t.name === STAFFPASS_PROFILE_TOOL_NAME && !out.outputSchema) {
      out.outputSchema = STAFFPASS_PROFILE_OUTPUT_SCHEMA;
    }
    return out;
  });
}

export function authChallengeMeta(opts: { error?: "invalid_token"; description?: string } = {}) {
  return { "mcp/www_authenticate": [wwwAuthenticate(opts)] };
}

export const GB_EMP_AUTH_SENTENCE = "Authenticate with Authorization: Bearer gb_emp_….";
export const OAUTH_AUTH_SENTENCE =
  "Authenticate with OAuth (your client opens the Staffpass sign-in/consent screen; scope staffpass.employee) or, for headless agents, Authorization: Bearer gb_emp_…. Use staffpass_profile to show which employee/org is connected.";

/** Swap the auth sentence in the initialize instructions. */
export function oauthInstructions(base: string): string {
  return base.replace(GB_EMP_AUTH_SENTENCE, OAUTH_AUTH_SENTENCE);
}

export function oauthServerCardAuth() {
  return {
    oauth: {
      authorizationServer: oauthIssuer(),
      protectedResourceMetadata: protectedResourceMetadataUrl(),
      scopes: [OAUTH_SCOPE_EMPLOYEE],
      clientRegistration: "client_id_metadata_document",
    },
  };
}
