/** RFC 9728 PRM + RFC 8414 AS metadata (design §3). */
import {
  OAUTH_SCOPE_EMPLOYEE,
  OAUTH_SCOPE_OFFLINE,
  isMcpOAuthDcrEnabled,
  oauthIssuer,
  oauthMcpResource,
} from "@/lib/mcp-oauth/config";

export function protectedResourceMetadata(kind: "mcp" | "root") {
  const issuer = oauthIssuer();
  return {
    resource: kind === "mcp" ? oauthMcpResource() : issuer,
    authorization_servers: [issuer],
    scopes_supported: [OAUTH_SCOPE_EMPLOYEE],
    bearer_methods_supported: ["header"],
    resource_name: "Staffpass",
    resource_documentation: `${issuer}/docs/mcp`,
  };
}

export function authorizationServerMetadata() {
  const issuer = oauthIssuer();
  const meta: Record<string, unknown> = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/api/oauth/token`,
    revocation_endpoint: `${issuer}/api/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    scopes_supported: [OAUTH_SCOPE_EMPLOYEE, OAUTH_SCOPE_OFFLINE],
    service_documentation: `${issuer}/docs/mcp`,
  };
  if (isMcpOAuthDcrEnabled()) meta.registration_endpoint = `${issuer}/api/oauth/register`;
  return meta;
}

export const METADATA_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "public, max-age=300",
  "Access-Control-Allow-Origin": "*",
};
