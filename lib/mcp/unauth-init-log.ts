/**
 * Q4 (MCP OAuth rollout): temporary, flag-gated observation of MCP clients that
 * call `initialize` on /api/mcp WITHOUT any credential header.
 *
 * Why: when MCP_OAUTH_ENABLED goes ON, unauthenticated `initialize` will get
 * 401 + WWW-Authenticate (OAuth discovery). Before that, we want to know which
 * clients (if any) rely on unauthenticated initialize.
 *
 * Flag: MCP_UNAUTH_INIT_LOG_ENABLED (default OFF). Remove after rollout.
 *
 * Logged fields (one JSON line, console.info):
 *   event, clientName, clientVersion, protocolVersion, userAgent
 * Never logged: Authorization / x-staffpass-credential values, cookies, IPs,
 * request body beyond clientInfo.name/version + protocolVersion.
 * Every string is truncated and stripped of control characters.
 */

const MAX_FIELD = 120;

export function isMcpUnauthInitLogEnabled(): boolean {
  const v = (process.env.MCP_UNAUTH_INIT_LOG_ENABLED ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "enabled";
}

export function sanitizeLogField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_FIELD ? `${cleaned.slice(0, MAX_FIELD)}…` : cleaned;
}

/** True when the request carries no credential header at all (presence only). */
export function hasNoCredentialHeader(req: Request): boolean {
  const auth = req.headers.get("authorization");
  const alt = req.headers.get("x-staffpass-credential");
  return !(auth && auth.trim()) && !(alt && alt.trim());
}

export type UnauthInitLogEntry = {
  event: "mcp.unauth_initialize";
  clientName: string | null;
  clientVersion: string | null;
  protocolVersion: string | null;
  userAgent: string | null;
};

export function buildUnauthInitLogEntry(
  req: Request,
  params: Record<string, unknown>
): UnauthInitLogEntry {
  const clientInfo =
    params && typeof params.clientInfo === "object" && params.clientInfo !== null
      ? (params.clientInfo as Record<string, unknown>)
      : {};
  return {
    event: "mcp.unauth_initialize",
    clientName: sanitizeLogField(clientInfo.name),
    clientVersion: sanitizeLogField(clientInfo.version),
    protocolVersion: sanitizeLogField(params?.protocolVersion),
    userAgent: sanitizeLogField(req.headers.get("user-agent")),
  };
}

/**
 * Call on every `initialize`. No-op unless the flag is ON and the request has
 * no credential header. Never throws.
 */
export function maybeLogUnauthInitialize(
  req: Request,
  params: Record<string, unknown>,
  log: (line: string) => void = (line) => console.info(line)
): void {
  try {
    if (!isMcpUnauthInitLogEnabled()) return;
    if (!hasNoCredentialHeader(req)) return;
    log(JSON.stringify(buildUnauthInitLogEntry(req, params)));
  } catch {
    // observation only — never affect the response
  }
}
