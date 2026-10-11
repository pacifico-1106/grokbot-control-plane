/**
 * Was the approved file shared in the approved Slack thread? (2026-10-04,
 * #253 follow-up 1+2). Read-only: auth.test (who posts with this token) and
 * conversations.replies (the thread since the claim), both form-encoded via
 * slackRequestBody; the token is sent only as `Authorization: Bearer …`.
 *
 * Matching (all three, on the file object Slack returns):
 *   name  === the approved filename (exact)
 *   size  === the approved byte size (exact)
 *   poster === auth.test user_id (the bot user, or the employee's user for
 *             postingAs=user) — file.user, else the message's user
 * and the message ts must be at/after the claim time.
 *
 *   exactly one exact match, nothing similar                 → found (file id)
 *   complete scan, no exact and no similar file              → not_found
 *   anything else                                            → unverifiable(code)
 *     similar = same name with another size / poster, or same poster + size
 *               with another name, or an exact match up to SKEW before the claim
 *     also: more than one exact match, a file without name/size (hidden /
 *     access-limited), more pages than MAX_PAGES, any API / network error.
 * "not_found" is only returned after a complete, error-free scan, so a share we
 * could not see is never reported as "not shared".
 */
import { slackRequestBody } from "@/lib/slack/web-api-request";

const SLACK_API = "https://slack.com/api";
const SLACK_TIMEOUT_MS = 10_000;
/** Look this far before the claim so a near-claim share is seen (→ ambiguous). */
export const SHARE_LOOKUP_SKEW_SECONDS = 120;
export const SHARE_LOOKUP_MAX_PAGES = 5;
const PAGE_LIMIT = 200;
/** The only value taken from Slack into the record (later shown by the status poll). */
const SLACK_FILE_ID = /^F[A-Z0-9_]{1,63}$/;

export type ShareLookupResult =
  | { kind: "found"; fileId: string }
  | { kind: "not_found" }
  | { kind: "unverifiable"; code: string };

type SlackAnswer = { ok: true; data: Record<string, unknown> } | { ok: false; code: string };

function slackCode(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return /^[a-z0-9_]{1,64}$/.test(raw) ? raw : "slack_error";
}

async function call(token: string, method: "auth.test" | "conversations.replies", args: Record<string, unknown>): Promise<SlackAnswer> {
  try {
    const request = slackRequestBody(method, args);
    const response = await fetch(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": request.contentType },
      body: request.body,
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!data || typeof data !== "object") return { ok: false, code: `http_${response.status}` };
    if (data.ok !== true) return { ok: false, code: slackCode(data.error) };
    return { ok: true, data };
  } catch {
    return { ok: false, code: "network_error" };
  }
}

const unverifiable = (code: string): ShareLookupResult => ({ kind: "unverifiable", code });
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export async function findApprovedFileShare(input: {
  token: string;
  channel: string;
  threadTs: string;
  filename: string;
  bytes: number;
  claimedAt: Date;
}): Promise<ShareLookupResult> {
  const auth = await call(input.token, "auth.test", {});
  if (!auth.ok) return unverifiable(`reconcile_slack_${auth.code}`);
  const me = str(auth.data.user_id);
  if (!me) return unverifiable("reconcile_poster_unknown");

  const claimSeconds = input.claimedAt.getTime() / 1000;
  const oldest = (Math.floor(claimSeconds) - SHARE_LOOKUP_SKEW_SECONDS).toFixed(6);
  let exact: string[] = [];
  let similar = 0;
  let cursor: string | undefined;
  for (let page = 0; page < SHARE_LOOKUP_MAX_PAGES; page++) {
    const answer = await call(input.token, "conversations.replies", {
      channel: input.channel, ts: input.threadTs, oldest, inclusive: true, limit: PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    if (!answer.ok) return unverifiable(`reconcile_slack_${answer.code}`);
    const messages = Array.isArray(answer.data.messages) ? answer.data.messages : [];
    for (const raw of messages) {
      const message = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const ts = Number(message.ts);
      const files = Array.isArray(message.files) ? message.files : [];
      for (const rawFile of files) {
        const file = rawFile && typeof rawFile === "object" ? (rawFile as Record<string, unknown>) : {};
        const name = str(file.name);
        const size = typeof file.size === "number" ? file.size : undefined;
        if (!name || size === undefined) return unverifiable("reconcile_file_details_hidden");
        const poster = str(file.user) ?? str(message.user);
        const sameName = name === input.filename;
        const sameSize = size === input.bytes;
        const mine = poster === me;
        if (sameName && sameSize && mine) {
          const id = str(file.id);
          if (!id || !SLACK_FILE_ID.test(id)) return unverifiable("reconcile_file_details_hidden");
          if (Number.isFinite(ts) && ts >= Math.floor(claimSeconds)) exact.push(id);
          else similar++;
        } else if ((sameName && (!sameSize || !mine)) || (mine && sameSize)) {
          similar++;
        }
      }
    }
    const meta = answer.data.response_metadata as { next_cursor?: unknown } | undefined;
    cursor = answer.data.has_more === true ? str(meta?.next_cursor) : undefined;
    if (answer.data.has_more === true && !cursor) return unverifiable("reconcile_scan_truncated");
    if (!cursor) {
      exact = [...new Set(exact)];
      if (exact.length === 1 && similar === 0) return { kind: "found", fileId: exact[0] };
      if (exact.length === 0 && similar === 0) return { kind: "not_found" };
      return unverifiable("reconcile_ambiguous_match");
    }
  }
  return unverifiable("reconcile_scan_truncated");
}
