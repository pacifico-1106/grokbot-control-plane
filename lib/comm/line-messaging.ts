/**
 * LINE Messaging API (fixed host only). Used by owner/admin LINE conversation
 * connect to fetch the bot userId and to set / test the webhook URL.
 *
 * SSRF: every request is `https://api.line.me` + a compile-time path. The
 * access token is an Authorization header only and is never logged.
 */
export const LINE_API_ORIGIN = "https://api.line.me";
export const LINE_API_HOST = "api.line.me";
const TIMEOUT_MS = 10_000;
const BOT_USER_RE = /^U[0-9a-f]{32}$/;

export const LINE_MESSAGING_PATHS = {
  botInfo: "/v2/bot/info",
  webhookEndpoint: "/v2/bot/channel/webhook/endpoint",
  webhookTest: "/v2/bot/channel/webhook/test",
} as const;

export type LineMessagingPath = (typeof LINE_MESSAGING_PATHS)[keyof typeof LINE_MESSAGING_PATHS];

export type LineMessagingFailure = {
  ok: false;
  reason:
    | "token_unauthorized"
    | "bot_info_invalid"
    | "bot_info_http"
    | "line_network"
    | "webhook_set_failed"
    | "webhook_test_failed"
    | "webhook_test_rejected";
  httpStatus?: number;
};

export type LineBotInfo = { userId: string; displayName: string | null };

function lineUrl(path: LineMessagingPath): URL {
  const url = new URL(path, LINE_API_ORIGIN);
  if (url.protocol !== "https:" || url.hostname !== LINE_API_HOST || url.port !== "") {
    throw new Error("line_api_host_invalid");
  }
  return url;
}

type HttpOk = { kind: "ok"; status: number; json: unknown };
type Http = HttpOk | { kind: "status"; status: number } | { kind: "network" };

async function lineFetch(
  path: LineMessagingPath,
  accessToken: string,
  init: { method: "GET" | "PUT" | "POST"; body?: unknown }
): Promise<Http> {
  const url = lineUrl(path);
  try {
    const res = await fetch(url, {
      method: init.method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { kind: "status", status: res.status };
    const json = await res.json().catch(() => null);
    return { kind: "ok", status: res.status, json };
  } catch {
    return { kind: "network" };
  }
}

function unauthorizedOr(reason: LineMessagingFailure["reason"], http: Extract<Http, { kind: "status" }>): LineMessagingFailure {
  if (http.status === 401) return { ok: false, reason: "token_unauthorized", httpStatus: 401 };
  return { ok: false, reason, httpStatus: http.status };
}

export async function fetchLineBotInfo(accessToken: string): Promise<{ ok: true; bot: LineBotInfo } | LineMessagingFailure> {
  const r = await lineFetch(LINE_MESSAGING_PATHS.botInfo, accessToken, { method: "GET" });
  if (r.kind === "network") return { ok: false, reason: "line_network" };
  if (r.kind === "status") return unauthorizedOr("bot_info_http", r);
  const rec = r.json && typeof r.json === "object" ? (r.json as Record<string, unknown>) : null;
  const userId = typeof rec?.userId === "string" ? rec.userId.trim() : "";
  if (!BOT_USER_RE.test(userId)) return { ok: false, reason: "bot_info_invalid" };
  const displayName = typeof rec?.displayName === "string" ? rec.displayName.trim().slice(0, 200) || null : null;
  return { ok: true, bot: { userId, displayName } };
}

export async function setLineWebhookEndpoint(
  accessToken: string,
  endpoint: string
): Promise<{ ok: true } | LineMessagingFailure> {
  const r = await lineFetch(LINE_MESSAGING_PATHS.webhookEndpoint, accessToken, {
    method: "PUT",
    body: { endpoint },
  });
  if (r.kind === "network") return { ok: false, reason: "line_network" };
  if (r.kind === "status") return unauthorizedOr("webhook_set_failed", r);
  return { ok: true };
}

export async function testLineWebhookEndpoint(
  accessToken: string,
  endpoint: string
): Promise<{ ok: true } | LineMessagingFailure> {
  const r = await lineFetch(LINE_MESSAGING_PATHS.webhookTest, accessToken, {
    method: "POST",
    body: { endpoint },
  });
  if (r.kind === "network") return { ok: false, reason: "line_network" };
  if (r.kind === "status") return unauthorizedOr("webhook_test_failed", r);
  const rec = r.json && typeof r.json === "object" ? (r.json as Record<string, unknown>) : null;
  if (rec?.success !== true) return { ok: false, reason: "webhook_test_rejected" };
  return { ok: true };
}
