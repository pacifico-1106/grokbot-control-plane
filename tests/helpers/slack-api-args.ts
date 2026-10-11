/**
 * Test helper: read the arguments of a mocked Slack Web API call the way Slack does.
 *
 * - application/x-www-form-urlencoded → parsed form fields.
 * - application/json → parsed only for methods whose official docs list JSON as an
 *   accepted content type. For read methods that do not accept JSON (users.info,
 *   conversations.info, …) Slack drops the JSON args and answers as if they were never
 *   sent (users.info → user_not_found), so this returns {} for them.
 *
 * Mocks that blindly JSON.parse the body hid the production bug where users.info was
 * sent as JSON.
 */
const JSON_ACCEPTING_METHODS = new Set([
  "auth.test",
  "conversations.open",
  "chat.postMessage",
  "chat.update",
  "reactions.add",
  "reactions.remove",
  "files.completeUploadExternal",
]);

export function slackRequestHeader(init: RequestInit | undefined, name: string): string {
  const headers = init?.headers;
  if (!headers) return "";
  if (headers instanceof Headers) return headers.get(name) ?? "";
  if (Array.isArray(headers)) {
    const hit = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return hit ? String(hit[1]) : "";
  }
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    if (key.toLowerCase() === name.toLowerCase()) return String(value);
  }
  return "";
}

export function slackApiArgs(method: string, init: RequestInit | undefined): Record<string, unknown> {
  const raw = init?.body == null ? "" : String(init.body);
  if (!raw) return {};
  const contentType = slackRequestHeader(init, "content-type").toLowerCase();
  if (contentType.startsWith("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  if (contentType.startsWith("application/json")) {
    if (!JSON_ACCEPTING_METHODS.has(method)) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}
