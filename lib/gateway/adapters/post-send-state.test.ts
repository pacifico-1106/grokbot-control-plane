/**
 * Duplicate post guard (5): a failed post says whether it is CONFIRMED not
 * sent ("not_sent": nothing was submitted, or the provider answered with a
 * definite pre-post error) or may have gone out ("unknown": timeout, network
 * error after submit, 5xx / non-JSON answer, ok without a message id, any
 * unlisted error). The guard keeps the ledger row for "unknown".
 * Demo mode, dummy token, fetch recorded, no network.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { postConversationMessage } from "./slack";
import { publishSnsPost } from "./sns";

const originalFetch = globalThis.fetch;
const savedX = process.env.SNS_X_ACCESS_TOKEN;
const savedStub = process.env.SNS_PUBLISH_STUB;

beforeAll(async () => {
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: true, secrets: { botToken: "xoxb-send-state-test" } });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (savedX === undefined) delete process.env.SNS_X_ACCESS_TOKEN;
  else process.env.SNS_X_ACCESS_TOKEN = savedX;
  if (savedStub === undefined) delete process.env.SNS_PUBLISH_STUB;
  else process.env.SNS_PUBLISH_STUB = savedStub;
});
afterAll(async () => {
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
});

function slackAnswers(answer: () => Promise<Response> | Response) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("chat.postMessage")) return answer();
    return Response.json({ ok: false, error: "unexpected_fetch" });
  }) as typeof fetch;
}
const post = () => postConversationMessage({ orgId: DEMO_ORG.id, employeeId: "emp_comm", postingAs: "bot", channel: "C0SENDSTATE", text: "hello" });

describe("Slack conversation post: sendState on failure", () => {
  test("definite Slack error (channel_not_found / not_in_channel / invalid_auth) → not_sent", async () => {
    for (const error of ["channel_not_found", "not_in_channel", "invalid_auth", "msg_too_long"]) {
      slackAnswers(() => Response.json({ ok: false, error }));
      const res = await post();
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.sendState).toBe("not_sent");
    }
  });

  test("nothing submitted (no destination) → not_sent", async () => {
    const res = await postConversationMessage({ orgId: DEMO_ORG.id, channel: " ", text: "hello" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.sendState).toBe("not_sent");
  });

  test("timeout / network error after submit → unknown", async () => {
    slackAnswers(() => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    const res = await post();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.sendState).toBe("unknown");
  });

  test("DNS / connection refused (never reached Slack) → not_sent", async () => {
    slackAnswers(() => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND slack.com"), { code: "ENOTFOUND" }) });
    });
    const res = await post();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.sendState).toBe("not_sent");
  });

  test("5xx / non-JSON answer, ratelimited, unlisted error, ok without ts → unknown", async () => {
    const answers: Array<() => Response> = [
      () => new Response("<html>bad gateway</html>", { status: 502 }),
      () => Response.json({ ok: false, error: "ratelimited" }, { status: 429 }),
      () => Response.json({ ok: false, error: "internal_error" }),
      () => Response.json({ ok: true, channel: "C0SENDSTATE" }),
    ];
    for (const answer of answers) {
      slackAnswers(answer);
      const res = await post();
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.sendState).toBe("unknown");
    }
  });
});

describe("SNS (X) post: sendState on failure", () => {
  const publish = () => publishSnsPost({ orgId: DEMO_ORG.id, employeeId: "emp_sns", surface: "x", text: "hello" });
  test("pre-submit refusals (no surface / empty text) → not_sent", async () => {
    const none = await publishSnsPost({ orgId: DEMO_ORG.id, surface: "", text: "x" });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.sendState).toBe("not_sent");
    const empty = await publishSnsPost({ orgId: DEMO_ORG.id, surface: "x", text: " " });
    if (!empty.ok) expect(empty.sendState).toBe("not_sent");
  });
  test("4xx answer → not_sent; 5xx / timeout → unknown", async () => {
    delete process.env.SNS_PUBLISH_STUB;
    process.env.SNS_X_ACCESS_TOKEN = "dummy-x-token";
    globalThis.fetch = (async () => Response.json({ title: "Forbidden" }, { status: 403 })) as unknown as typeof fetch;
    const forbidden = await publish();
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.sendState).toBe("not_sent");
    globalThis.fetch = (async () => new Response("oops", { status: 503 })) as unknown as typeof fetch;
    const unavailable = await publish();
    if (!unavailable.ok) expect(unavailable.sendState).toBe("unknown");
    globalThis.fetch = (async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as unknown as typeof fetch;
    const timedOut = await publish();
    if (!timedOut.ok) expect(timedOut.sendState).toBe("unknown");
  });
});
