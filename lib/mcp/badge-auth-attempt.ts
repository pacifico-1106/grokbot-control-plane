/**
 * Detect a static employee-badge attempt on /api/mcp so we can withhold the
 * OAuth discovery challenge (WWW-Authenticate resource_metadata).
 *
 * Why: MCP 2025-11-25 Authorization requires clients that see 401 +
 * resource_metadata to start OAuth discovery (and DCR when advertised).
 * Grok Bot connectors that send an empty / unexpanded Bearer
 * (`${env:STAFFPASS_MCP_TOKEN}`) therefore fall into OAuth and stop on
 * invalid_redirect_uri. A request that is trying to present a badge must
 * not be treated as an unauthenticated OAuth client.
 *
 * Gated by MCP_EMPLOYEE_BADGE_MCP_ENABLED (default OFF).
 */
import { isEmployeeBadgeMcpEnabled } from "@/lib/feature-flags";
import { ACCESS_TOKEN_PREFIX, isMcpOAuthEnabled } from "@/lib/mcp-oauth/config";

/** Same Japanese next step for every 401 badge failure — does not say whether a secret exists. */
export const BADGE_AUTH_NEXT_STEP_JA =
  "社員証（gb_emp_）をコネクタのシークレット欄に、Bearer 付きの静的な値として入れてください。${env:…} の展開は使わないでください。OAuth ではなく社員証で接続します。";

function headerPresent(req: Request, name: string): boolean {
  return req.headers.get(name) !== null;
}

/** Fetch joins duplicate Authorization values with ", ". Split back into challenges. */
const AUTH_CHALLENGE_SPLIT = /,(?=\s*(?:Bearer|Basic|Digest|Negotiate|HOBA|Mutual|OAuth)\b)/i;

function authorizationChallenges(req: Request): string[] {
  const raw = req.headers.get("authorization");
  if (raw === null) return [];
  return raw
    .split(AUTH_CHALLENGE_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function bearerToken(challenge: string): string | null {
  const m = /^Bearer(?:\s+(.*))?$/i.exec(challenge.trim());
  if (!m) return null;
  return (m[1] ?? "").trim();
}

function isOauthAccessBearer(challenge: string): boolean {
  const tok = bearerToken(challenge);
  return Boolean(tok && tok.startsWith(ACCESS_TOKEN_PREFIX));
}

/**
 * True when the caller is presenting (or attempting to present) a static badge,
 * including empty / unexpanded Authorization values. OAuth access tokens
 * (`sp_at_`) are not badge attempts. A mixed set of Authorization challenges
 * (sp_at_ plus empty Bearer / Basic / gb_emp_) is still a badge attempt —
 * only an all-sp_at_ Authorization set is treated as OAuth.
 */
export function looksLikeBadgeAuthAttempt(req: Request): boolean {
  if (headerPresent(req, "x-staffpass-credential")) return true;
  if (!headerPresent(req, "authorization")) return false;
  const challenges = authorizationChallenges(req);
  if (challenges.length === 0) return true;
  return !challenges.every(isOauthAccessBearer);
}

/** RFC 9728 / MCP challenge. False → do not send resource_metadata. */
export function shouldAdvertiseOAuthChallenge(req: Request): boolean {
  if (!isMcpOAuthEnabled()) return false;
  if (isEmployeeBadgeMcpEnabled() && looksLikeBadgeAuthAttempt(req)) return false;
  return true;
}

export function badgeAuthErrorData(code: string): Record<string, unknown> {
  return { code, nextStepJa: BADGE_AUTH_NEXT_STEP_JA };
}
