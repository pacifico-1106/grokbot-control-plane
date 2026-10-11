/**
 * Slack Web API request body encoding, chosen by method.
 *
 * Slack read methods such as users.info do not accept a JSON body: Slack drops the
 * JSON arguments and answers as if they were never sent (users.info without `user`
 * → user_not_found). Those methods are sent as application/x-www-form-urlencoded.
 * Write methods that accept JSON (conversations.open, chat.postMessage, …) stay JSON.
 *
 * Refs (method pages, "Accepted content types"):
 *   https://api.slack.com/methods/users.info  (form only; "does not currently accept application/json")
 *   https://api.slack.com/web#posting_json   (JSON is for write methods)
 *
 * The token is never put in the body or URL: callers send it only as
 * `Authorization: Bearer …`. A `token` argument is dropped defensively.
 */
export const SLACK_FORM_METHODS: ReadonlySet<string> = new Set([
  "auth.test",
  "users.info",
  "users.lookupByEmail",
  "users.conversations",
  "conversations.info",
  "conversations.members",
  "conversations.replies",
  "team.info",
]);

export function slackRequestBody(
  method: string,
  args: Record<string, unknown>
): { contentType: string; body: string } {
  const entries = Object.entries(args).filter(([key]) => key !== "token");
  if (SLACK_FORM_METHODS.has(method)) {
    const form = new URLSearchParams();
    for (const [key, value] of entries) {
      if (value === undefined || value === null) continue;
      form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
    return { contentType: "application/x-www-form-urlencoded", body: form.toString() };
  }
  return { contentType: "application/json; charset=utf-8", body: JSON.stringify(Object.fromEntries(entries)) };
}
